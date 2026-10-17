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
interface Proj {
  id: number;
  path: string;
  defaultBranch: string | null;
  archived: boolean;
  branches: Map<string, Branch>;
  mrs: Mr[];
}

export interface RecordedRequest {
  method: string;
  /** Path without the query string. */
  path: string;
}

const sha = () => Bun.randomUUIDv7().replaceAll("-", "").padEnd(40, "0").slice(0, 40);

export function createMockGitlab(opts: MockOptions = {}) {
  const token = opts.token ?? "mock-token-0123456789";
  const maxPerPage = opts.maxPerPage ?? 100;
  const projects: Proj[] = [];
  const groups: { id: number; name: string; full_path: string }[] = [];
  const requests: RecordedRequest[] = [];
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
      };
      projects.push(proj);
      return { id: proj.id, path: proj.path };
    },
    stop: () => server.stop(true),
  };
}

export type MockGitlab = ReturnType<typeof createMockGitlab>;
