import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { newApiToken } from "@orch/api/tokens";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createApiToken,
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  projects,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab } from "@orch/gitlab/mock";
import { loadTemplates, type Template } from "@orch/pipelines";
import { eq } from "drizzle-orm";
import { CliError, runCli } from "./cli";
import { pipelineCommands } from "./pipeline";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 6).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
const ids = {} as Record<"acme" | "beta", string>;
const tokens = {} as Record<"admin" | "reporter", string>;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();

/** The shipped Bun template, and one like it that needs a variable the projects here do not have. */
const NEEDY = "needs-token";
async function catalog(): Promise<Template[]> {
  const [bun] = (await loadTemplates()).filter((c) => c.manifest.name === "bun-app");
  if (!bun) throw new Error("no bun-app template");
  return [
    bun,
    { ...bun, manifest: { ...bun.manifest, name: NEEDY, requiresVariables: ["DEPLOY_TOKEN"] } },
  ];
}

const makeApp = (templates: Template[]) =>
  createApp({
    logger: createLogger({ level: "error", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
    templates,
  });

/** Credentials that must never reach a terminal: the one to GitLab and the caller's own. */
const printed: string[] = [];

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  ids.acme = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  ids.beta = (await createOrganization(t.db, { slug: "beta", name: "Beta Inc" })).id;
  for (const [org, names] of [
    [ids.acme, ["live"]],
    [ids.beta, ["live", "spare"]],
  ] as const) {
    for (const name of names) {
      await createConnection(t.db, keys, {
        organizationId: org,
        type: "gitlab",
        name,
        config: { baseUrl: mock.url },
        token: mock.token,
      });
    }
  }

  // a connection that is not GitLab's: it is never a choice for a pipeline
  await createConnection(t.db, keys, {
    organizationId: ids.acme,
    type: "registry",
    name: "images",
    config: { baseUrl: mock.url },
    token: "not-a-gitlab-token",
  });

  let gitlabId = 800;
  for (const name of ["admin", "reporter"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const fresh = newApiToken();
    await createApiToken(t.db, {
      userId: user.id,
      name: "test",
      prefix: fresh.prefix,
      tokenHash: fresh.tokenHash,
      scopes: ["*"],
      ttlMs: 3_600_000,
    });
    tokens[name] = fresh.token;
  }
  roleTable.set(801, { orgRoles: { [ids.acme]: "admin", [ids.beta]: "admin" }, projectRoles: {} });
  roleTable.set(802, { orgRoles: { [ids.acme]: "member" }, projectRoles: {} });

  app = makeApp(await catalog()).listen({ port: 0, hostname: "127.0.0.1" });
  api = `http://127.0.0.1:${app.server?.port}`;
  dir = await mkdtemp(join(tmpdir(), "orch-pipeline-"));
});
afterAll(async () => {
  await app.stop(true);
  mock.stop();
  await t.drop();
  await rm(dir, { recursive: true, force: true });
  const everything = printed.join("\n");
  expect(everything).not.toContain(mock.token);
  expect(everything).not.toContain(tokens.admin);
});

interface Run {
  token?: string | undefined;
  /** Answers `confirm`; without it there is no terminal to ask. */
  answer?: boolean;
}
const asked: string[] = [];
async function orch(argv: string[], run: Run = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: {
      ORCH_CONFIG: join(dir, "no-config.json"),
      ORCH_API_URL: api,
      ORCH_TOKEN: "token" in run ? run.token : tokens.admin,
    },
    cwd: dir,
    home: dir,
    stdin: async () => "",
    open: async () => {},
    confirm: async (question) => {
      asked.push(question);
      if (run.answer === undefined) {
        throw new CliError("cannot ask for confirmation without a terminal; pass --yes", 2);
      }
      return run.answer;
    },
    version: "0.0.0",
    commands: pipelineCommands(),
  });
  printed.push(...out, ...err);
  return { code, out, err };
}

let n = 0;
/** A project (detected as a Bun project) on a GitLab project of its own, in `acme` unless said. */
async function world(
  over: {
    org?: "acme" | "beta";
    files?: Record<string, string>;
    environments?: string[];
    detected?: boolean;
  } = {},
) {
  const name = `app${++n}`;
  const orgSlug = over.org ?? "acme";
  const gl = mock.addProject({ path: `fx/${name}`, ...(over.files ? { files: over.files } : {}) });
  const project = await createProject(t.db, {
    organizationId: ids[orgSlug],
    name,
    gitlabProjectId: gl.id,
  });
  await t.db
    .update(projects)
    .set({
      detectedTypes:
        over.detected === false ? [] : [{ tag: "bun", confidence: "high", evidence: ["bun.lock"] }],
    })
    .where(eq(projects.id, project.id));
  for (const slug of over.environments ?? []) {
    await createEnvironment(t.db, {
      organizationId: ids[orgSlug],
      projectId: project.id,
      name: slug,
      slug,
    });
  }
  const mine = (path: string) =>
    path.includes(`/projects/${gl.id}/`) ||
    path.includes(`/projects/${encodeURIComponent(gl.path)}/`);
  return {
    name,
    label: `${orgSlug}/${name}`,
    args: ["--org", orgSlug, "--project", name],
    /** How many commits GitLab was asked to make on this project. */
    commits: () =>
      mock.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith("/repository/commits") && mine(r.path),
      ).length,
    /** The pipeline file on the default branch, or nothing. */
    onMain: async () => {
      const res = await fetch(
        `${mock.url}/api/v4/projects/${gl.id}/repository/files/${encodeURIComponent(".gitlab-ci.yml")}/raw?ref=main`,
        { headers: { "private-token": mock.token } },
      );
      return res.ok ? await res.text() : null;
    },
  };
}

const BUN_LINE = /^ {2}bun-app 1\.0\.0 {2}high {2}\S.*bun.*$/;

describe("detect", () => {
  test("says what is set up and what suits the project", async () => {
    const w = await world();
    const res = await orch(["pipeline", "detect", ...w.args]);
    expect(res.code).toBe(0);
    expect(res.err).toEqual([]);
    const lines = res.out.join("\n").split("\n");
    expect(lines.slice(0, 2)).toEqual([`${w.label}: no pipeline set up`, "suits this project:"]);
    expect(lines.filter((l) => BUN_LINE.test(l))).toHaveLength(1);
  });

  test("says so when no template suits the project", async () => {
    const w = await world({ detected: false });
    const res = await orch(["pipeline", "detect", ...w.args]);
    expect(res.out).toEqual([`${w.label}: no pipeline set up\nno template suits this project`]);
  });

  test("--json is the config and the recommendations", async () => {
    const w = await world();
    const res = await orch(["pipeline", "detect", ...w.args, "--json"]);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.out.join("")) as {
      config: unknown;
      recommendations: { template: string; version: string; confidence: string }[];
    };
    expect(doc.config).toBeNull();
    expect(doc.recommendations).toContainEqual(
      expect.objectContaining({ template: "bun-app", version: "1.0.0", confidence: "high" }),
    );
  });
});

describe("setup", () => {
  test("--dry-run prints the file, says what would happen on stderr, and commits nothing", async () => {
    const w = await world();
    const res = await orch(["pipeline", "setup", "bun-app", ...w.args, "--dry-run"]);
    expect(res.code).toBe(0);
    expect(res.err).toEqual([`${w.label}: bun-app 1.0.0, inline: would add .gitlab-ci.yml`]);
    const file = res.out.join("\n");
    expect(file).toContain("stages:");
    expect(file).not.toMatch(/\n$/);
    expect(w.commits()).toBe(0);
    expect(await w.onMain()).toBeNull();
  });

  test("--yes opens one merge request and leaves the default branch alone; again is a no-op; detect shows it", async () => {
    const w = await world();
    const first = await orch(["pipeline", "setup", "bun-app", ...w.args, "--yes"]);
    expect(first.code).toBe(0);
    const mrLine = new RegExp(
      `^${w.label}: opened merge request !1 http://127\\.0\\.0\\.1:\\d+/\\S+$`,
    );
    expect(first.out).toEqual([expect.stringMatching(mrLine)]);
    expect(w.commits()).toBe(1);
    expect(await w.onMain()).toBeNull();

    const again = await orch(["pipeline", "setup", "bun-app", ...w.args, "--yes"]);
    expect(again.code).toBe(0);
    expect(again.out[0]).toContain(`${w.label}: merge request already up to date: !1 `);
    expect(w.commits()).toBe(1);

    const seen = await orch(["pipeline", "detect", ...w.args]);
    expect(seen.out[0]).toMatch(
      new RegExp(
        `^${w.label}: set up with bun-app 1\\.0\\.0 \\(inline\\), merge request http://\\S+`,
      ),
    );
  });

  test("asks first: yes opens the merge request, no and no terminal commit nothing", async () => {
    const w = await world();
    const args = ["pipeline", "setup", "bun-app", ...w.args];
    const no = await orch(args, { answer: false });
    expect(no.code).toBe(1);
    expect(no.err.at(-1)).toBe("error: cancelled; nothing was changed");
    expect(asked.at(-1)).toBe(`Open a merge request for ${w.label}?`);
    const none = await orch(args);
    expect(none.code).toBe(2);
    expect(none.err.at(-1)).toContain("without a terminal");
    expect(w.commits()).toBe(0);

    const yes = await orch(args, { answer: true });
    expect(yes.code).toBe(0);
    expect(yes.out[0]).toContain("opened merge request !1");
    expect(w.commits()).toBe(1);
  });

  test("a file that already matches on the default branch needs no question and no merge request", async () => {
    const dry = await orch(["pipeline", "setup", "bun-app", ...(await world()).args, "--dry-run"]);
    const w = await world({ files: { ".gitlab-ci.yml": `${dry.out.join("\n")}\n` } });
    const res = await orch(["pipeline", "setup", "bun-app", ...w.args]);
    expect(res.code).toBe(0);
    expect(res.err).toEqual([`${w.label}: bun-app 1.0.0, inline: .gitlab-ci.yml already matches`]);
    expect(res.out).toEqual([
      `${w.label}: .gitlab-ci.yml on the default branch already matches, nothing to do`,
    ]);
    expect(w.commits()).toBe(0);
  });

  test("a hand-written file on the default branch is said to be replaced by the merge request", async () => {
    const w = await world({ files: { ".gitlab-ci.yml": "build:\n  script: [echo hi]\n" } });
    const res = await orch(["pipeline", "setup", "bun-app", ...w.args, "--dry-run"]);
    expect(res.code).toBe(0);
    expect(res.err).toEqual([
      `${w.label}: bun-app 1.0.0, inline: would replace the hand-written .gitlab-ci.yml (the merge request says so)`,
    ]);
  });

  test("--param is text and goes into the file; --param-json is a number or true/false", async () => {
    const w = await world();
    const res = await orch([
      "pipeline",
      "setup",
      "bun-app",
      ...w.args,
      "--dry-run",
      "--param",
      "bunVersion=1.2.3",
    ]);
    expect(res.code).toBe(0);
    expect(res.out.join("\n")).toContain("1.2.3");
    // a number is not a bunVersion: the API says so
    const typed = await orch([
      "pipeline",
      "setup",
      "bun-app",
      ...w.args,
      "--dry-run",
      "--param-json",
      "bunVersion=12",
    ]);
    expect(typed.code).toBe(1);
    expect(typed.err).toHaveLength(1);
    expect(typed.err[0]).toMatch(/^error: .*bunVersion/);
    // true and false are as much values as a number: they are sent, and the API is the one to refuse
    const flag = await orch([
      "pipeline",
      "setup",
      "bun-app",
      ...w.args,
      "--dry-run",
      "--param-json",
      "bunVersion=false",
    ]);
    expect(flag.code).toBe(1);
    expect(flag.err[0]).toMatch(/^error: .*bunVersion/);
  });

  test.each([
    [["--param", "nope"], "--param takes name=value, with a name of letters, digits and _"],
    [["--param", "1x=a"], "--param takes name=value, with a name of letters, digits and _"],
    [["--param-json", "=1"], "--param-json takes name=value, with a name of letters, digits and _"],
    [["--param", "a=1", "--param", "a=2"], "parameter a is given twice"],
    [["--param", "a=1", "--param-json", "a=2"], "parameter a is given twice"],
    [
      ["--param-json", "a=sekrit"],
      "--param-json takes a number, true or false; give text with --param",
    ],
    [
      ["--param-json", 'a="text"'],
      "--param-json takes a number, true or false; give text with --param",
    ],
    [["--mode", "both"], "unknown mode 'both'; use inline or include"],
    [["--include-ref", "main"], "--include-ref needs --include-project"],
    [["--mode", "include"], "--mode include needs --include-project"],
    [
      ["--mode", "inline", "--include-project", "fx/templates"],
      "--include-project goes with --mode include",
    ],
  ])("%j is a usage error and asks the API nothing", async (flags, message) => {
    const w = await world();
    const before = mock.requests.length;
    const res = await orch(["pipeline", "setup", "bun-app", ...w.args, "--dry-run", ...flags]);
    expect(res.code).toBe(2);
    expect(res.err).toEqual([`error: ${message}`]);
    expect(res.out).toEqual([]);
    expect(mock.requests).toHaveLength(before);
  });

  test("warns of variables the pipeline needs, per environment, and still goes ahead", async () => {
    const w = await world({ environments: ["dev", "prod"] });
    const res = await orch(["pipeline", "setup", NEEDY, ...w.args, "--yes"]);
    expect(res.code).toBe(0);
    expect(res.err).toEqual([
      `${w.label}: ${NEEDY} 1.0.0, inline: would add .gitlab-ci.yml`,
      "warning: variables the pipeline needs that are not set: dev: DEPLOY_TOKEN; prod: DEPLOY_TOKEN",
    ]);
    expect(res.out[0]).toContain("opened merge request !1");

    const one = await world({ environments: ["dev", "prod"] });
    const some = await orch([
      "pipeline",
      "setup",
      NEEDY,
      ...one.args,
      "--dry-run",
      "--environment",
      "prod",
    ]);
    expect(some.err[1]).toBe(
      "warning: variables the pipeline needs that are not set: prod: DEPLOY_TOKEN",
    );
    const nowhere = await orch([
      "pipeline",
      "setup",
      NEEDY,
      ...one.args,
      "--dry-run",
      "--environment",
      "qa",
    ]);
    expect(nowhere.code).toBe(1);
    expect(nowhere.err[0]).toContain("qa");
  });

  test("an unknown template is the API's refusal", async () => {
    const w = await world();
    const res = await orch(["pipeline", "setup", "no-such-template", ...w.args, "--dry-run"]);
    expect(res.code).toBe(1);
    expect(res.err).toHaveLength(1);
    expect(res.err[0]).toMatch(/^error: .*no-such-template/);
    expect(w.commits()).toBe(0);
  });

  test("include mode is sent, and GitLab's lint refusing it stops before anything is asked or committed", async () => {
    const w = await world();
    const res = await orch([
      "pipeline",
      "setup",
      "bun-app",
      ...w.args,
      "--include-project",
      "fx/nowhere",
    ]);
    expect(res.code).toBe(1);
    expect(res.err).toHaveLength(1);
    expect(res.err[0]).toMatch(/^error: GitLab's lint refuses this pipeline: .+/);
    expect(res.out).toEqual([]);
    expect(w.commits()).toBe(0);
  });
});

describe("connections", () => {
  test("with several GitLab connections --connection is needed, by name or id", async () => {
    const w = await world({ org: "beta" });
    const base = ["pipeline", "setup", "bun-app", ...w.args, "--dry-run"];
    const none = await orch(base);
    expect(none.code).toBe(2);
    expect(none.err).toEqual([
      expect.stringMatching(
        /^error: 2 GitLab connections: pass --connection; known: (live, spare|spare, live)$/,
      ),
    ]);
    const named = await orch([...base, "--connection", "spare"]);
    expect(named.code).toBe(0);
    const unknown = await orch([...base, "--connection", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err[0]).toMatch(/^error: no GitLab connection 'nope'; known: /);
  });
});

describe("who may", () => {
  test("a member who is not on the project may read what suits it, but not set anything up", async () => {
    const w = await world();
    const read = await orch(["pipeline", "detect", ...w.args], { token: tokens.reporter });
    expect(read.code).toBe(0);
    const set = await orch(["pipeline", "setup", "bun-app", ...w.args, "--yes"], {
      token: tokens.reporter,
    });
    expect(set.code).toBe(1);
    expect(set.err).toHaveLength(1);
    expect(set.err[0]).toContain("forbidden");
    expect(w.commits()).toBe(0);
  });
});

describe("usage", () => {
  test.each([
    [["pipeline"]],
    [["pipeline", "detect", "extra"]],
    [["pipeline", "setup"]],
    [["pipeline", "setup", "a", "b"]],
    [["pipeline", "frob"]],
  ])("%j is a usage error and asks the API nothing", async (argv) => {
    const before = mock.requests.length;
    const res = await orch(argv, { token: undefined });
    expect(res.code).toBe(2);
    expect(res.err).toEqual([
      "error: usage: orch pipeline detect [options] | orch pipeline setup <template> [options]",
    ]);
    expect(mock.requests).toHaveLength(before);
  });

  test("no token is 'not signed in'", async () => {
    const res = await orch(["pipeline", "detect", "--org", "acme", "--project", "x"], {
      token: undefined,
    });
    expect(res.code).toBe(1);
    expect(res.err).toEqual(["error: not signed in; run: orch login"]);
  });
});
