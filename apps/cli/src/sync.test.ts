import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { SYNC_APPLY, syncApplyHandler } from "@orch/api/sync-apply";
import { newApiToken } from "@orch/api/tokens";
import { createWorker, type Worker } from "@orch/api/worker";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createApiToken,
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab } from "@orch/gitlab/mock";
import { CliError, runCli } from "./cli";
import { syncCommands } from "./sync";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 5).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
let worker: Worker;
/** The worker's apply waits for this; a test holds it to keep an apply running. */
let hold: Promise<void> = Promise.resolve();
const pause = () => {
  const gate = Promise.withResolvers<void>();
  hold = gate.promise;
  return gate.resolve;
};
const ids = {} as Record<"org" | "connection", string>;
const tokens = {} as Record<"admin" | "reporter", string>;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();

const makeApp = () =>
  createApp({
    logger: createLogger({ level: "error", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
  });

/** Values that must never reach a terminal: the secret of the project, in every line any command printed. */
const apiKey = `SEKRIT-api-key-${Bun.randomUUIDv7()}`;
const printed: string[] = [];

async function send(method: string, path: string, body?: unknown) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as never };
}

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  ids.org = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  ids.connection = (
    await createConnection(t.db, keys, {
      organizationId: ids.org,
      type: "gitlab",
      name: "live",
      config: { baseUrl: mock.url },
      token: mock.token,
    })
  ).id;

  let gitlabId = 600;
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
  roleTable.set(601, { orgRoles: { [ids.org]: "admin" }, projectRoles: {} });
  roleTable.set(602, { orgRoles: { [ids.org]: "member" }, projectRoles: {} });

  app = makeApp().listen({ port: 0, hostname: "127.0.0.1" });
  api = `http://127.0.0.1:${app.server?.port}`;
  dir = await mkdtemp(join(tmpdir(), "orch-sync-"));

  const logger = createLogger({ level: "error", write: () => {} });
  const applying = syncApplyHandler({ db: t.db, keys, logger });
  worker = createWorker({
    db: t.db,
    logger,
    handlers: {
      [SYNC_APPLY]: async (ctx) => {
        await hold;
        await applying(ctx);
      },
    },
    pollMs: 10,
    backoff: () => 0,
  });
  worker.start();
});
afterAll(async () => {
  await worker.stop();
  await app.stop(true);
  mock.stop();
  await t.drop();
  await rm(dir, { recursive: true, force: true });
  // the secret of every project was in every plan and every apply, and in none of what was printed
  expect(printed.join("\n")).not.toContain(apiKey);
});

interface Run {
  token?: string | undefined;
  /** Answers `confirm`; without it there is no terminal to ask. */
  answer?: boolean;
  commands?: ReturnType<typeof syncCommands>;
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
    commands: run.commands ?? syncCommands({ pollMs: 5 }),
  });
  printed.push(...out, ...err);
  return { code, out, err };
}

/** Ids and times are different on every run; the rest of what is printed is exact. */
const golden = (lines: string[]) =>
  lines
    .join("\n")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>");
const planId = (res: { out: string[] }) => /sync plan (\S+) for/.exec(res.out[0] ?? "")?.[1] ?? "";

let n = 0;
/** A project called `web<n>` of the organization, with a GitLab project of its own and one target `main` on it. */
async function world(over: { policy?: string; second?: string | boolean } = {}) {
  const id = ++n;
  const name = `web${id}`;
  const projectId = (await createProject(t.db, { organizationId: ids.org, name })).id;
  const envId = (
    await createEnvironment(t.db, {
      organizationId: ids.org,
      projectId,
      name: "prod",
      slug: "prod",
    })
  ).id;
  const path = `/organizations/${ids.org}/projects/${projectId}`;
  const gl = mock.addProject({ path: `fx/${name}` });
  mock.addMember({ project: gl.id }, mock.tokenUser.id, 40);
  const target = async (targetName: string) => {
    const made = await send("POST", `${path}/sync-targets`, {
      name: targetName,
      type: "gitlab-variables",
      connectionId: ids.connection,
      config: { project: gl.path },
      environmentMapping: { prod: "production" },
      ...(over.policy ? { unmanagedPolicy: over.policy } : {}),
    });
    expect(made.status).toBe(201);
  };
  // the adapter names the project by its path
  const variables = `/api/v4/projects/${encodeURIComponent(gl.path)}/variables`;
  const w = {
    name,
    path,
    gl,
    args: ["--org", "acme", "--project", name],
    /** A variable of the project, or of its environment. */
    put: async (at: "project" | "prod", key: string, kind: string, value: string) => {
      const base = at === "project" ? path : `${path}/environments/${envId}`;
      expect((await send("POST", `${base}/variables`, { key, kind, value })).status).toBe(201);
    },
    /** A variable on the GitLab project, as if put there by hand. */
    seed: (key: string, value: string, scope = "*", masked = false) =>
      fetch(`${mock.url}/api/v4/projects/${gl.id}/variables`, {
        method: "POST",
        headers: { "private-token": mock.token, "content-type": "application/json" },
        body: JSON.stringify({ key, value, environment_scope: scope, masked }),
      }).then((r) => expect(r.status).toBe(201)),
    /** What was sent to this GitLab project to change a variable, in order: `POST`, `PUT /KEY`, `DELETE /KEY`. */
    writes: () =>
      mock.requests
        .filter((r) => r.method !== "GET" && r.path.startsWith(`${variables}`))
        .map((r) => `${r.method} ${r.path.slice(variables.length)}`.trim()),
    /** What the GitLab project holds now, `KEY scope`, by key. */
    held: async () => {
      const res = await fetch(`${mock.url}/api/v4/projects/${gl.id}/variables?per_page=100`, {
        headers: { "private-token": mock.token },
      });
      const all = (await res.json()) as { key: string; environment_scope: string; value: string }[];
      return all
        .map((v) => ({ at: `${v.key} ${v.environment_scope}`, value: v.value }))
        .sort((a, b) => a.at.localeCompare(b.at));
    },
    /** The next requests of this kind to this GitLab project are refused with `status`. */
    refuse: (method: string, status: number) =>
      mock.inject({
        method,
        path: new RegExp(`/projects/${encodeURIComponent(gl.path)}/variables`),
        status,
      }),
    run: async (runId: string) => {
      const targets = await send("GET", `${path}/sync-targets`);
      const [first] = (targets.json as { items: { id: string }[] }).items;
      return (await send("GET", `${path}/sync-targets/${first?.id}/runs/${runId}`)).json as {
        status: string;
      };
    },
  };
  await target("main");
  if (over.second) await target(typeof over.second === "string" ? over.second : "backup");
  await w.put("project", "APP_NAME", "plain", "web");
  await w.put("prod", "API_KEY", "secret", apiKey);
  await w.put("prod", "LOG_LEVEL", "plain", "info");
  return w;
}

describe("plan", () => {
  test("shows what the sync would change, in what the target already holds, and writes nothing", async () => {
    const w = await world({ policy: "prune" });
    await w.seed("APP_NAME", "web");
    await w.seed("LOG_LEVEL", "debug", "production");
    await w.seed("OLD_KEY", "stale");
    await w.put("project", "BROKEN", "plain", `x\${NOT_THERE}y`);
    const res = await orch(["sync", "plan", ...w.args]);
    expect(res.code).toBe(0);
    expect(res.err).toEqual([]);
    expect(golden(res.out)).toBe(
      [
        `sync plan <id> for acme/${w.name}: create 1, update 1, delete 1, adopt 0, noop 1`,
        "  create  API_KEY    production",
        "  update  LOG_LEVEL  production  (value)",
        "  delete  OLD_KEY    *",
        "left out: BROKEN * (missing); BROKEN production (missing)",
        "expires <time>",
        "apply with: orch sync apply <id>",
      ].join("\n"),
    );
    expect(w.writes()).toEqual([]);
  });
});

const plan = (w: { args: string[] }, extra: string[] = [], run: Run = {}) =>
  orch(["sync", "plan", ...w.args, ...extra], run);
const apply = (w: { args: string[] }, id: string, extra: string[] = [], run: Run = {}) =>
  orch(["sync", "apply", id, ...w.args, ...extra], run);

describe("plan, more", () => {
  test("--json is the stored plan, and the secret is not in it", async () => {
    const w = await world();
    const res = await plan(w, ["--json"]);
    expect(res.code).toBe(0);
    expect(res.err).toEqual([]);
    const doc = JSON.parse(res.out.join("")) as { status: string; counts: object; items: object[] };
    expect(doc).toMatchObject({
      status: "planned",
      counts: { create: 3, update: 0, delete: 0, adopt: 0, noop: 0 },
    });
    expect(doc.items).toHaveLength(3);
    expect(res.out.join("")).not.toContain(apiKey);
    expect(w.writes()).toEqual([]);
  });

  test("names the target in the hint when --target was given", async () => {
    const w = await world({ second: true });
    const res = await plan(w, ["--target", "backup"]);
    expect(res.code).toBe(0);
    expect(res.out.join("\n").split("\n").at(-1)).toMatch(
      /^apply with: orch sync apply \S+ --target backup$/,
    );
  });
});

describe("plan hint", () => {
  test("is a command that can be pasted, whatever the target is called", async () => {
    const w = await world({ second: "eu west's" });
    const res = await plan(w, ["--target", "eu west's"]);
    expect(res.code).toBe(0);
    expect(res.out.join("\n").split("\n").at(-1)).toMatch(
      /^apply with: orch sync apply \S+ --target 'eu west'\\''s'$/,
    );
  });
});

describe("apply", () => {
  test("--yes applies the plan to the target, once, and says what was done", async () => {
    const w = await world();
    const id = planId(await plan(w));
    const res = await apply(w, id, ["--yes"]);
    expect(res.code).toBe(0);
    expect(res.err).toEqual([]);
    expect(golden(res.out)).toBe(
      [
        `sync plan <id> for acme/${w.name}: create 3, update 0, delete 0, adopt 0, noop 0`,
        "  create  API_KEY    production",
        "  create  APP_NAME   *",
        "  create  LOG_LEVEL  production",
        "expires <time>",
        `sync run <id> for acme/${w.name}: applied, 3 applied, 0 failed`,
      ].join("\n"),
    );
    expect(w.writes()).toEqual(["POST", "POST", "POST"]);
    expect(await w.held()).toEqual([
      { at: "API_KEY production", value: apiKey },
      { at: "APP_NAME *", value: "web" },
      { at: "LOG_LEVEL production", value: "info" },
    ]);

    // the plan is spent
    const again = await apply(w, id, ["--yes"]);
    expect(again.code).toBe(1);
    expect(again.err).toEqual([
      `error: plan ${id} is applied, not waiting to be applied: plan again`,
    ]);
    expect(w.writes()).toEqual(["POST", "POST", "POST"]);
  });

  test("asks first, and says how many deletes there are; yes applies, no and no terminal change nothing", async () => {
    const w = await world({ policy: "prune" });
    await w.seed("OLD_KEY", "stale");
    const id = planId(await plan(w));

    const no = await apply(w, id, [], { answer: false });
    expect(no.code).toBe(1);
    expect(no.err).toEqual(["error: cancelled; nothing was changed"]);
    expect(asked.at(-1)).toBe(`Apply 4 changes (1 deletes) to acme/${w.name}?`);

    const none = await apply(w, id);
    expect(none.code).toBe(2);
    expect(none.err[0]).toContain("without a terminal");
    expect(w.writes()).toEqual([]);
    expect((await w.run(id)).status).toBe("planned");

    const yes = await apply(w, id, [], { answer: true });
    expect(yes.code).toBe(0);
    expect(yes.out.at(-1)).toContain(": applied, 4 applied, 0 failed");
    expect(w.writes().sort()).toEqual(["DELETE /OLD_KEY", "POST", "POST", "POST"]);
  });

  test("a plan with nothing to change is not applied, and nothing is asked", async () => {
    const w = await world();
    await w.seed("APP_NAME", "web");
    await w.seed("API_KEY", apiKey, "production", true);
    await w.seed("LOG_LEVEL", "info", "production");
    const planned = await plan(w);
    expect(planned.out[0]).toContain("create 0, update 0, delete 0, adopt 0, noop 3");
    const before = asked.length;
    const res = await apply(w, planId(planned));
    expect(res.code).toBe(0);
    expect(res.out.at(-1)).toBe("nothing to apply");
    expect(asked).toHaveLength(before);
    expect(w.writes()).toEqual([]);
  });

  test("a line the target refuses is reported by key and scope, the others are applied, and it exits 1", async () => {
    const w = await world();
    const id = planId(await plan(w));
    w.refuse("POST", 400);
    const res = await apply(w, id, ["--yes"]);
    expect(res.code).toBe(1);
    expect(res.out.at(-1)).toMatch(/: failed, 2 applied, 1 failed$/);
    expect(res.err[0]).toBe("error: 1 of 3 changes failed");
    expect(res.err).toHaveLength(2);
    expect(res.err[1]).toMatch(/^ {2}failed (API_KEY|APP_NAME|LOG_LEVEL) (\*|production): \S/);
    expect(await w.held()).toHaveLength(2);
  });

  test("is refused, with the API's reason, when the variables changed since the plan", async () => {
    const w = await world();
    const id = planId(await plan(w));
    await w.put("project", "LATE", "plain", "x");
    const res = await apply(w, id, ["--yes"]);
    expect(res.code).toBe(1);
    expect(res.err).toHaveLength(1);
    expect(res.err[0]).toMatch(/^error: .*(changed|stale)/i);
    expect(w.writes()).toEqual([]);
  });

  test("--json is the finished run", async () => {
    const w = await world();
    const id = planId(await plan(w));
    const res = await apply(w, id, ["--yes", "--json"]);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.out.join("")) as { id: string; status: string; items: object[] };
    expect(doc).toMatchObject({ id, status: "applied" });
    expect(doc.items).toHaveLength(3);
    expect(res.out.join("")).not.toContain(apiKey);
  });

  test("gives up waiting after the limit, says the apply goes on, and it does", async () => {
    const w = await world();
    const id = planId(await plan(w));
    const release = pause();
    try {
      const res = await apply(w, id, ["--yes"], {
        commands: syncCommands({ waitMs: 1_000, pollMs: 10 }),
      });
      expect(res.code).toBe(1);
      expect(res.err).toEqual([
        expect.stringMatching(
          /^error: run \S+ is still applying after 1 s; it goes on without this command$/,
        ),
      ]);
      expect(w.writes()).toEqual([]);
    } finally {
      release();
    }
    for (let i = 0; i < 200 && (await w.run(id)).status === "applying"; i++) await Bun.sleep(25);
    expect((await w.run(id)).status).toBe("applied");
    expect(w.writes()).toEqual(["POST", "POST", "POST"]);
  });
});

describe("apply, losing track", () => {
  test("a look at the run that fails names the run and says it goes on", async () => {
    const w = await world();
    const id = planId(await plan(w));
    // a token that runs out while the apply is held: the first looks work, a later one is refused
    const admin = await upsertUser(t.db, { gitlabId: 601, username: "admin", name: "admin" });
    const brief = newApiToken();
    await createApiToken(t.db, {
      userId: admin.id,
      name: "brief",
      prefix: brief.prefix,
      tokenHash: brief.tokenHash,
      scopes: ["*"],
      ttlMs: 1_000,
    });
    const release = pause();
    try {
      const res = await apply(w, id, ["--yes"], { token: brief.token });
      expect(res.code).toBe(1);
      expect(res.err).toEqual([
        expect.stringMatching(
          new RegExp(`^error: lost track of run ${id}: .+; it goes on without this command$`),
        ),
      ]);
    } finally {
      release();
    }
    for (let i = 0; i < 200 && (await w.run(id)).status === "applying"; i++) await Bun.sleep(25);
    expect((await w.run(id)).status).toBe("applied");
  });
});

describe("targets", () => {
  test("with several, --target is needed; a name picks one; an unknown one lists the known", async () => {
    const w = await world({ second: true });
    const none = await plan(w);
    expect(none.code).toBe(2);
    expect(none.err).toEqual([
      expect.stringMatching(
        /^error: 2 sync targets: pass --target; known: (backup, main|main, backup)$/,
      ),
    ]);
    const unknown = await plan(w, ["--target", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err[0]).toMatch(/^error: no sync target 'nope'; known: /);
    expect((await plan(w, ["--target", "main"])).code).toBe(0);
    expect(w.writes()).toEqual([]);
  });

  test("a project without a target says so", async () => {
    await createProject(t.db, { organizationId: ids.org, name: "bare" });
    const res = await orch(["sync", "plan", "--org", "acme", "--project", "bare"]);
    expect(res.code).toBe(2);
    expect(res.err).toEqual(["error: no sync target here"]);
  });
});

describe("who may", () => {
  test("a member who is not on the project is told it is forbidden, for plan and apply", async () => {
    const w = await world();
    const id = planId(await plan(w));
    const denied = await plan(w, [], { token: tokens.reporter });
    expect(denied.code).toBe(1);
    expect(denied.err[0]).toContain("forbidden");
    const apply403 = await apply(w, id, ["--yes"], { token: tokens.reporter });
    expect(apply403.code).toBe(1);
    expect(apply403.err[0]).toContain("forbidden");
    expect(w.writes()).toEqual([]);
    expect((await w.run(id)).status).toBe("planned");
  });
});

describe("usage", () => {
  test.each([
    [["sync"]],
    [["sync", "plan", "extra"]],
    [["sync", "plan", "--yes"]],
    [["sync", "apply"]],
    [["sync", "apply", "a", "b"]],
    [["sync", "unplan"]],
  ])("%j is a usage error and asks the API nothing", async (argv) => {
    const before = mock.requests.length;
    const res = await orch(argv, { token: undefined });
    expect(res.code).toBe(2);
    expect(res.err).toEqual([
      "error: usage: orch sync plan [options] | orch sync apply <plan-id> [--yes] [options]",
    ]);
    expect(mock.requests).toHaveLength(before);
  });

  test("no token is 'not signed in'", async () => {
    const res = await orch(["sync", "plan", "--org", "acme", "--project", "x"], {
      token: undefined,
    });
    expect(res.code).toBe(1);
    expect(res.err).toEqual(["error: not signed in; run: orch login"]);
  });
});
