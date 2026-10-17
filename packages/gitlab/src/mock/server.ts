/**
 * In-process fake of the GitLab endpoints the platform uses (GL-2..4), for tests everywhere.
 * It follows GitLab's documented behaviour; the contract suite (`../contract.ts`) is what keeps it
 * honest, by running the same assertions against a real sandbox group when one is configured.
 */

export interface MockProjectInput {
  /** Full path, `group/sub/repo`. */
  path: string;
  defaultBranch?: string | null;
  archived?: boolean;
  /** Files on the default branch. */
  files?: Record<string, string>;
}

export interface MockOptions {
  token?: string;
  /** Server-side cap on `per_page` (GitLab's is 100); a small value exercises pagination. */
  maxPerPage?: number;
}

interface Branch {
  head: string;
  files: Map<string, string>;
}
interface Note {
  id: number;
  body: string;
  system: boolean;
}
interface Mr {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed" | "merged";
  source_branch: string;
  target_branch: string;
  notes: Note[];
}
interface MockJob {
  id: number;
  name: string;
  stage: string;
  status: string;
  allow_failure: boolean;
}
interface Pipe {
  id: number;
  iid: number;
  ref: string;
  sha: string;
  status: string;
  jobs: MockJob[];
  /** Kept for tests; GitLab never returns trigger variables, and neither does the mock. */
  variables: { key: string; value: string }[];
}
interface MockVar {
  key: string;
  value: string;
  variable_type: "env_var" | "file";
  protected: boolean;
  masked: boolean;
  hidden: boolean;
  raw: boolean;
  environment_scope: string;
  description: string | null;
}
interface Proj {
  id: number;
  path: string;
  defaultBranch: string | null;
  archived: boolean;
  branches: Map<string, Branch>;
  mrs: Mr[];
  pipelines: Pipe[];
  variables: MockVar[];
}

/**
 * A canned failure for matching requests, to exercise retry and error handling. It applies before
 * authentication and routing, like a failing proxy in front of GitLab.
 */
export interface Injection {
  method?: string;
  /** Matched against the path without the query; a string must match exactly. */
  path?: string | RegExp;
  status: number;
  /** How many matching requests fail before the mock behaves again. Default 1. */
  times?: number;
  /** Sent as `Retry-After`, in seconds. */
  retryAfter?: number;
}

export interface RecordedRequest {
  method: string;
  /** Path without the query string. */
  path: string;
}

const NOT_JOBS = new Set([
  "stages",
  "variables",
  "default",
  "workflow",
  "include",
  "image",
  "services",
  "cache",
  "before_script",
  "after_script",
]);

/** The few CI rules the platform relies on: a mapping, and every visible job has a script. */
function checkCi(content: string) {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(content);
  } catch {
    return { jobs: [], errors: ["Invalid configuration format"] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { jobs: [], errors: ["Invalid configuration format"] };
  }
  const jobs: { name: string; stage: string; manual: boolean }[] = [];
  const errors: string[] = [];
  for (const [name, def] of Object.entries(doc)) {
    if (NOT_JOBS.has(name) || name.startsWith(".")) continue;
    const j = (def && typeof def === "object" ? def : {}) as Record<string, unknown>;
    if (!("script" in j) && !("trigger" in j)) {
      errors.push(`jobs:${name} config should implement the script:, run:, or trigger: keyword`);
    }
    jobs.push({
      name,
      stage: typeof j.stage === "string" ? j.stage : "test",
      manual: j.when === "manual",
    });
  }
  if (jobs.length === 0 && errors.length === 0) errors.push("No stages / jobs for this pipeline.");
  return { jobs, errors };
}

/** GitLab's documented masking rules, written out again here so the contract can test `canMask`. */
const maskable = (v: string, raw: boolean) =>
  /^\S{8,}$/.test(v) && (raw || /^[A-Za-z0-9_:@+.~=/-]+$/.test(v));

const sha = () => Bun.randomUUIDv7().replaceAll("-", "").padEnd(40, "0").slice(0, 40);

export function createMockGitlab(opts: MockOptions = {}) {
  const token = opts.token ?? "mock-token-0123456789";
  const maxPerPage = opts.maxPerPage ?? 100;
  const projects: Proj[] = [];
  const groups: { id: number; name: string; full_path: string }[] = [];
  const groupVars = new Map<number, MockVar[]>();
  const requests: RecordedRequest[] = [];
  const injections: (Injection & { left: number })[] = [];
  let seq = 0;

  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const fail = (status: number, message: string) => json({ message }, status);

  const find = (ref: string) => projects.find((p) => String(p.id) === ref || p.path === ref);

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const u = new URL(req.url);
      requests.push({ method: req.method, path: u.pathname });
      const injected = injections.find(
        (i) =>
          i.left > 0 &&
          (!i.method || i.method === req.method) &&
          (!i.path ||
            (typeof i.path === "string" ? i.path === u.pathname : i.path.test(u.pathname))),
      );
      if (injected) {
        injected.left--;
        return json(
          { message: `injected ${injected.status}` },
          injected.status,
          injected.retryAfter === undefined ? {} : { "retry-after": String(injected.retryAfter) },
        );
      }
      const origin = u.origin;
      const bearer = req.headers.get("authorization");
      if (req.headers.get("private-token") !== token && bearer !== `Bearer ${token}`) {
        return fail(401, "401 Unauthorized");
      }
      if (!u.pathname.startsWith("/api/v4/")) return fail(404, "404 Not Found");
      const rest = u.pathname.slice("/api/v4".length);
      const q = (k: string) => u.searchParams.get(k) ?? undefined;
      const body = (req.method === "GET" ? {} : await req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const page = (items: unknown[]) => {
        const per = Math.min(Number(q("per_page") ?? 20), maxPerPage);
        const start = Number(q("page_token") ?? 0);
        const headers: Record<string, string> = {};
        if (start + per < items.length) {
          const next = new URL(u);
          next.searchParams.set("page_token", String(start + per));
          headers.link = `<${next}>; rel="next"`;
        }
        return json(items.slice(start, start + per), 200, headers);
      };
      const projectJson = (p: Proj) => ({
        id: p.id,
        name: p.path.split("/").pop(),
        path_with_namespace: p.path,
        default_branch: p.defaultBranch,
        web_url: `${origin}/${p.path}`,
        archived: p.archived,
        visibility: "private",
      });

      /** `/variables` and `/variables/:key` of a project or group, as GitLab documents them. */
      const variablesRoute = (store: MockVar[], path: string) => {
        const vm = /^\/variables(?:\/([A-Za-z0-9_]+))?$/.exec(path);
        if (!vm) return undefined;
        const key = vm[1];
        const scope = q("filter[environment_scope]") ?? "*";
        const shape = (v: MockVar) => ({ ...v, value: v.hidden ? null : v.value });
        const taken = (k: string, s: string) =>
          store.some((v) => v.key === k && v.environment_scope === s);
        const check = (v: MockVar) =>
          v.masked && !maskable(v.value, v.raw)
            ? json({ message: { value: ["is invalid"] } }, 400)
            : undefined;
        if (!key) {
          if (req.method === "GET") return page(store.map(shape));
          if (req.method !== "POST") return undefined;
          const k = String(body.key ?? "");
          const hidden = body.masked_and_hidden === true;
          const v: MockVar = {
            key: k,
            value: typeof body.value === "string" ? body.value : "",
            variable_type: body.variable_type === "file" ? "file" : "env_var",
            protected: body.protected === true,
            masked: body.masked === true || hidden,
            hidden,
            raw: body.raw !== false,
            environment_scope: String(body.environment_scope ?? "*"),
            description: typeof body.description === "string" ? body.description : null,
          };
          if (!/^[A-Za-z0-9_]{1,255}$/.test(k) || typeof body.value !== "string") {
            return json({ message: { key: ["is invalid"] } }, 400);
          }
          if (taken(k, v.environment_scope)) {
            return json({ message: { key: [`(${k}) has already been taken`] } }, 400);
          }
          const bad = check(v);
          if (bad) return bad;
          store.push(v);
          return json(shape(v), 201);
        }
        const exact = store.find((v) => v.key === key && v.environment_scope === scope);
        // GitLab documents that an update with a filter matching nothing falls back to a same-named
        // variable of another scope; reads and deletes are assumed to do the same. The mock does it
        // everywhere so the client's exact-scope check is what keeps writes on the right variable.
        const hit = exact ?? store.find((v) => v.key === key);
        if (!hit) return fail(404, "404 Not Found");
        if (req.method === "GET") return json(shape(hit));
        if (req.method === "DELETE") {
          store.splice(store.indexOf(hit), 1);
          return new Response(null, { status: 204 });
        }
        if (req.method !== "PUT") return undefined;
        const next: MockVar = {
          ...hit,
          value: typeof body.value === "string" ? body.value : hit.value,
          variable_type:
            body.variable_type === "file"
              ? "file"
              : body.variable_type
                ? "env_var"
                : hit.variable_type,
          protected: typeof body.protected === "boolean" ? body.protected : hit.protected,
          masked: typeof body.masked === "boolean" ? body.masked : hit.masked,
          raw: typeof body.raw === "boolean" ? body.raw : hit.raw,
          environment_scope: String(body.environment_scope ?? hit.environment_scope),
          description:
            body.description === undefined ? hit.description : (body.description as string | null),
        };
        if (
          next.environment_scope !== hit.environment_scope &&
          taken(key, next.environment_scope)
        ) {
          return json({ message: { key: [`(${key}) has already been taken`] } }, 400);
        }
        const bad = check(next);
        if (bad) return bad;
        store[store.indexOf(hit)] = next;
        return json(shape(next));
      };

      const gv = /^\/groups\/([^/]+)(\/variables(?:\/.+)?)$/.exec(rest);
      if (gv) {
        const ref = decodeURIComponent(gv[1] ?? "");
        const hit = groups.find((x) => String(x.id) === ref || x.full_path === ref);
        const store = hit && groupVars.get(hit.id);
        if (!store) return fail(404, "404 Group Not Found");
        return variablesRoute(store, gv[2] ?? "") ?? fail(404, "404 Not Found");
      }

      if (req.method === "GET" && rest === "/projects") {
        const search = q("search");
        const archived = q("archived");
        return page(
          projects
            .filter((p) => !search || p.path.includes(search))
            .filter((p) => archived === undefined || String(p.archived) === archived)
            .map(projectJson),
        );
      }
      if (req.method === "GET" && rest === "/groups") {
        return page(groups.map((g) => ({ ...g, web_url: `${origin}/${g.full_path}` })));
      }
      const g = /^\/groups\/([^/]+)$/.exec(rest);
      if (g && req.method === "GET") {
        const ref = decodeURIComponent(g[1] ?? "");
        const hit = groups.find((x) => String(x.id) === ref || x.full_path === ref);
        return hit
          ? json({ ...hit, web_url: `${origin}/${hit.full_path}` })
          : fail(404, "404 Group Not Found");
      }

      const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(rest);
      if (!m) return fail(404, "404 Not Found");
      const proj = find(decodeURIComponent(m[1] ?? ""));
      if (!proj) return fail(404, "404 Project Not Found");
      const sub = m[2] ?? "";
      if (req.method === "GET" && sub === "") return json(projectJson(proj));
      const pv = variablesRoute(proj.variables, sub);
      if (pv) return pv;

      const branchOf = (name: string | undefined) =>
        proj.branches.get(name ?? proj.defaultBranch ?? "");

      if (req.method === "GET" && sub === "/repository/tree") {
        const b = branchOf(q("ref"));
        if (!b) return fail(404, "404 Tree Not Found");
        const base = (q("path") ?? "").replace(/\/$/, "");
        const prefix = base ? `${base}/` : "";
        const recursive = q("recursive") === "true";
        const entries = new Map<string, "blob" | "tree">();
        for (const file of b.files.keys()) {
          if (!file.startsWith(prefix)) continue;
          const parts = file.slice(prefix.length).split("/");
          const depth = recursive ? parts.length : 1;
          for (let i = 1; i <= depth; i++) {
            entries.set(prefix + parts.slice(0, i).join("/"), i === parts.length ? "blob" : "tree");
          }
        }
        return page(
          [...entries]
            .sort(([a], [b2]) => a.localeCompare(b2))
            .map(([path, type]) => ({
              id: sha(),
              name: path.split("/").pop(),
              type,
              path,
              mode: type === "tree" ? "040000" : "100644",
            })),
        );
      }

      const pipeJson = (p: Pipe) => ({
        id: p.id,
        iid: p.iid,
        status: p.status,
        ref: p.ref,
        sha: p.sha,
        web_url: `${origin}/${proj.path}/-/pipelines/${p.id}`,
      });
      const derive = (jobs: MockJob[]) =>
        jobs.length > 0 && jobs.every((j) => j.status === "manual") ? "manual" : "pending";

      if (req.method === "POST" && sub === "/pipeline") {
        const b = branchOf(String(body.ref ?? ""));
        if (!b) return json({ message: { base: ["Reference not found"] } }, 400);
        const vars = body.variables ?? [];
        if (
          !Array.isArray(vars) ||
          vars.some((v) => typeof v?.key !== "string" || !v.key || typeof v.value !== "string")
        ) {
          return fail(400, "variables is invalid");
        }
        const ci = b.files.get(".gitlab-ci.yml");
        if (ci === undefined) return json({ message: { base: ["Missing CI config file"] } }, 400);
        const checked = checkCi(ci);
        if (checked.errors.length) return json({ message: { base: checked.errors } }, 400);
        const jobs = checked.jobs.map((j) => ({
          id: ++seq,
          name: j.name,
          stage: j.stage,
          status: j.manual ? "manual" : "pending",
          allow_failure: j.manual,
        }));
        const p: Pipe = {
          id: ++seq,
          iid: proj.pipelines.length + 1,
          ref: String(body.ref),
          sha: b.head,
          status: derive(jobs),
          jobs,
          variables: vars.map((v) => ({ key: v.key, value: v.value })),
        };
        proj.pipelines.push(p);
        return json(pipeJson(p), 201);
      }

      if (req.method === "POST" && sub === "/ci/lint") {
        if (typeof body.content !== "string") return fail(400, "content is missing");
        const { errors } = checkCi(body.content);
        return json({
          valid: errors.length === 0,
          errors,
          warnings: [],
          merged_yaml: errors.length === 0 ? body.content : null,
        });
      }

      const pm = /^\/pipelines\/(\d+)(\/jobs|\/retry|\/cancel)?$/.exec(sub);
      if (pm) {
        const p = proj.pipelines.find((x) => x.id === Number(pm[1]));
        if (!p) return fail(404, "404 Pipeline Not Found");
        if (!pm[2] && req.method === "GET") return json(pipeJson(p));
        if (pm[2] === "/jobs" && req.method === "GET") {
          return page(
            p.jobs.map((j) => ({ ...j, web_url: `${origin}/${proj.path}/-/jobs/${j.id}` })),
          );
        }
        if (pm[2] === "/retry" && req.method === "POST") {
          const again = p.jobs.filter((j) => ["failed", "canceled"].includes(j.status));
          for (const j of again) j.status = "pending";
          if (again.length) p.status = derive(p.jobs);
          return json(pipeJson(p));
        }
        if (pm[2] === "/cancel" && req.method === "POST") {
          const live = p.jobs.filter((j) =>
            ["pending", "running", "manual", "created"].includes(j.status),
          );
          for (const j of live) j.status = "canceled";
          if (live.length) p.status = "canceled"; // a finished pipeline stays as it is
          return json(pipeJson(p));
        }
      }

      const f = /^\/repository\/files\/(.+)$/.exec(sub);
      if (req.method === "GET" && f) {
        const path = decodeURIComponent(f[1] ?? "");
        const ref = q("ref") ?? proj.defaultBranch ?? "";
        const b = proj.branches.get(ref);
        const content = b?.files.get(path);
        if (!b || content === undefined) return fail(404, "404 File Not Found");
        return json({
          file_path: path,
          file_name: path.split("/").pop(),
          ref,
          blob_id: sha(),
          commit_id: b.head,
          last_commit_id: b.head,
          size: Buffer.byteLength(content),
          encoding: "base64",
          content: Buffer.from(content).toString("base64"),
        });
      }

      if (req.method === "GET" && sub === "/repository/compare") {
        const from = proj.branches.get(q("from") ?? "");
        const to = proj.branches.get(q("to") ?? "");
        if (!from || !to) return fail(404, "404 Ref Not Found");
        const diffs: unknown[] = [];
        for (const path of [...new Set([...from.files.keys(), ...to.files.keys()])].sort()) {
          const a = from.files.get(path);
          const b = to.files.get(path);
          if (a === b) continue;
          diffs.push({
            old_path: path,
            new_path: path,
            new_file: a === undefined,
            deleted_file: b === undefined,
            renamed_file: false,
          });
        }
        return json({
          commits: diffs.length ? [{ id: to.head, title: "changes" }] : [],
          diffs,
          compare_timeout: false,
          compare_same_ref: q("from") === q("to"),
        });
      }

      const bd = /^\/repository\/branches\/([^/]+)$/.exec(sub);
      if (req.method === "DELETE" && bd) {
        const name = decodeURIComponent(bd[1] ?? "");
        if (!proj.branches.has(name)) return fail(404, "404 Branch Not Found");
        if (name === proj.defaultBranch) return fail(400, "Cannot remove HEAD branch");
        proj.branches.delete(name);
        for (const mr of proj.mrs) if (mr.source_branch === name) mr.state = "closed";
        return new Response(null, { status: 204 });
      }

      if (req.method === "POST" && sub === "/repository/branches") {
        const name = String(body.branch ?? "");
        const from = proj.branches.get(String(body.ref ?? ""));
        if (proj.branches.has(name)) return fail(400, "Branch already exists");
        if (!name || !from) return fail(400, `Invalid reference name: ${String(body.ref)}`);
        proj.branches.set(name, { head: from.head, files: new Map(from.files) });
        return json(
          {
            name,
            commit: { id: from.head },
            protected: false,
            default: false,
          },
          201,
        );
      }

      if (req.method === "POST" && sub === "/repository/commits") {
        const name = String(body.branch ?? "");
        let target = proj.branches.get(name);
        const start = body.start_branch ? proj.branches.get(String(body.start_branch)) : undefined;
        if (target && start) {
          return fail(
            400,
            `A branch called '${name}' already exists. Switch to that branch in order to make changes`,
          );
        }
        if (!target && !start) return fail(400, `A branch called '${name}' does not exist`);
        if (!body.commit_message) return fail(400, "commit_message is missing");
        const files = new Map((target ?? start)?.files);
        const actions = (body.actions ?? []) as {
          action: string;
          file_path: string;
          content?: string;
        }[];
        if (actions.length === 0) return fail(400, "actions is empty");
        for (const a of actions) {
          const exists = files.has(a.file_path);
          if (a.action === "create" && exists) {
            return fail(400, `A file with this name already exists: ${a.file_path}`);
          }
          if ((a.action === "update" || a.action === "delete") && !exists) {
            return fail(400, `A file with this name doesn't exist: ${a.file_path}`);
          }
          if (!["create", "update", "delete"].includes(a.action)) {
            return fail(400, `Unsupported action: ${a.action}`);
          }
          if (a.action === "delete") files.delete(a.file_path);
          else files.set(a.file_path, a.content ?? "");
        }
        const head = sha();
        target = { head, files };
        proj.branches.set(name, target);
        return json(
          { id: head, title: String(body.commit_message), web_url: `${origin}/commit/${head}` },
          201,
        );
      }

      if (sub === "/merge_requests" && req.method === "POST") {
        const src = String(body.source_branch ?? "");
        const tgt = String(body.target_branch ?? "");
        if (!proj.branches.has(src) || !proj.branches.has(tgt) || !body.title) {
          return fail(400, "source_branch, target_branch and title must be valid");
        }
        if (src === tgt) return fail(400, "Source and target branches must be different");
        if (
          proj.mrs.some(
            (x) => x.state === "opened" && x.source_branch === src && x.target_branch === tgt,
          )
        ) {
          return json(
            { message: ["Another open merge request already exists for this source branch"] },
            409,
          );
        }
        const mr: Mr = {
          id: ++seq,
          iid: proj.mrs.length + 1,
          title: String(body.title),
          description: body.description === undefined ? null : String(body.description),
          state: "opened",
          source_branch: src,
          target_branch: tgt,
          notes: [],
        };
        proj.mrs.push(mr);
        return json(mrJson(mr), 201);
      }

      const mrm = /^\/merge_requests\/(\d+)(\/notes(?:\/(\d+))?)?$/.exec(sub);
      if (mrm) {
        const mr = proj.mrs.find((x) => x.iid === Number(mrm[1]));
        if (!mr) return fail(404, "404 Merge Request Not Found");
        if (!mrm[2] && req.method === "GET") return json(mrJson(mr));
        if (!mrm[2] && req.method === "PUT") {
          if (body.title !== undefined) mr.title = String(body.title);
          if (body.description !== undefined) mr.description = String(body.description);
          if (body.target_branch !== undefined) mr.target_branch = String(body.target_branch);
          if (body.state_event === "close") mr.state = "closed";
          if (body.state_event === "reopen") mr.state = "opened";
          return json(mrJson(mr));
        }
        if (mrm[2] && !mrm[3] && req.method === "POST") {
          if (!body.body) return fail(400, "body is missing");
          const n = { id: ++seq, body: String(body.body), system: false };
          mr.notes.push(n);
          return json(n, 201);
        }
        if (mrm[3] && req.method === "PUT") {
          const n = mr.notes.find((x) => x.id === Number(mrm[3]));
          if (!n) return fail(404, "404 Note Not Found");
          n.body = String(body.body ?? n.body);
          return json(n);
        }
      }

      function mrJson(mr: Mr) {
        const { notes: _notes, ...rest } = mr;
        return {
          ...rest,
          web_url: `${origin}/${proj?.path}/-/merge_requests/${mr.iid}`,
          draft: false,
          sha: proj?.branches.get(mr.source_branch)?.head ?? null,
        };
      }

      return fail(404, "404 Not Found");
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    requests,
    addGroup(fullPath: string) {
      const group = { id: ++seq, name: fullPath.split("/").pop() ?? fullPath, full_path: fullPath };
      groups.push(group);
      groupVars.set(group.id, []);
      return group;
    },
    addProject(input: MockProjectInput) {
      const defaultBranch = input.defaultBranch === undefined ? "main" : input.defaultBranch;
      const branches = new Map<string, Branch>();
      if (defaultBranch !== null) {
        branches.set(defaultBranch, {
          head: sha(),
          files: new Map(Object.entries(input.files ?? { "README.md": "# Mock\n" })),
        });
      }
      const proj: Proj = {
        id: ++seq,
        path: input.path,
        defaultBranch,
        archived: input.archived ?? false,
        branches,
        mrs: [],
        pipelines: [],
        variables: [],
      };
      projects.push(proj);
      return { id: proj.id, path: proj.path };
    },
    /** Makes the next matching requests fail (see `Injection`). */
    inject(i: Injection) {
      injections.push({ ...i, left: i.times ?? 1 });
    },
    /** What a pipeline was triggered with (GitLab itself never shows these back). */
    pipelineVariables: (id: number) =>
      projects.flatMap((p) => p.pipelines).find((p) => p.id === id)?.variables,
    /** Plays the runner: every job of the pipeline ends in `status`. */
    finishPipeline(id: number, status: "success" | "failed") {
      const p = projects.flatMap((x) => x.pipelines).find((x) => x.id === id);
      if (!p) throw new Error(`no pipeline ${id}`);
      for (const j of p.jobs) j.status = status;
      p.status = status;
    },
    stop: () => server.stop(true),
  };
}

export type MockGitlab = ReturnType<typeof createMockGitlab>;
