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
  createEnvironment,
  createOrganization,
  createProject,
  createVariable,
  upsertUser,
  variableRotations,
  variables,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { eq } from "drizzle-orm";
import { CliError, runCli } from "./cli";
import { rotationCommands } from "./rotation";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 9).toString("base64")}`);

let t: TestDb;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
const ids = {} as Record<"org" | "web" | "dev" | "prod", string>;
const tokens = {} as Record<"admin" | "maintainer" | "reporter", string>;
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

/** What no command may print: the value a variable held, and the one a rotation put in its place. */
const secrets: string[] = [];
const quiet: string[] = [];
const OLD = `OLD-${Bun.randomUUIDv7()}`;
secrets.push(OLD);

const actor = { kind: "user", id: "setup" };
let n = 0;
const make = async (
  level: "org" | "project" | "env" | "prod",
  kind: "secret" | "plain" = "secret",
) => {
  const key = `ROT_${++n}`;
  const scope = {
    org: { organizationId: ids.org },
    project: { organizationId: ids.org, projectId: ids.web },
    env: { organizationId: ids.org, projectId: ids.web, environmentId: ids.dev },
    prod: { organizationId: ids.org, projectId: ids.web, environmentId: ids.prod },
  }[level];
  await createVariable(t.db, keys, { ...scope, key, kind, value: OLD, actor });
  return key;
};

const base = `/organizations`;
const listPath = (level: "org" | "project" | "env" | "prod") =>
  ({
    org: () => `${base}/${ids.org}/variables`,
    project: () => `${base}/${ids.org}/projects/${ids.web}/variables`,
    env: () => `${base}/${ids.org}/projects/${ids.web}/environments/${ids.dev}/variables`,
    prod: () => `${base}/${ids.org}/projects/${ids.web}/environments/${ids.prod}/variables`,
  })[level]();

/** The value the API holds for `key` (the revealing route, which is audited, and the only place a test may look). */
async function stored(level: "org" | "project" | "env", key: string) {
  const headers = { authorization: `Bearer ${tokens.admin}` };
  const list = await fetch(`${api}${listPath(level)}?limit=100`, { headers });
  const item = ((await list.json()) as { items: { id: string; key: string }[] }).items.find(
    (i) => i.key === key,
  );
  const res = await fetch(`${api}${listPath(level)}/${item?.id}/value`, { headers });
  return ((await res.json()) as { value: string }).value;
}

beforeAll(async () => {
  t = await createTestDb();
  ids.org = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  ids.web = (await createProject(t.db, { organizationId: ids.org, name: "web" })).id;
  const env = (slug: string, protectedEnv = false) =>
    createEnvironment(t.db, {
      organizationId: ids.org,
      projectId: ids.web,
      name: slug,
      slug,
      protected: protectedEnv,
    }).then((e) => e.id);
  ids.dev = await env("dev");
  ids.prod = await env("prod", true);

  let gitlabId = 820;
  for (const name of ["admin", "maintainer", "reporter"] as const) {
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
  roleTable.set(821, { orgRoles: { [ids.org]: "admin" }, projectRoles: {} });
  roleTable.set(822, {
    orgRoles: { [ids.org]: "member" },
    projectRoles: { [ids.web]: "maintainer" },
  });
  roleTable.set(823, {
    orgRoles: { [ids.org]: "member" },
    projectRoles: { [ids.web]: "reporter" },
  });
  app = makeApp().listen({ port: 0, hostname: "127.0.0.1" });
  api = `http://127.0.0.1:${app.server?.port}`;
  dir = await mkdtemp(join(tmpdir(), "orch-rotation-"));
});
afterAll(async () => {
  await app.stop(true);
  await t.drop();
  await rm(dir, { recursive: true, force: true });
  for (const marker of secrets) expect(quiet.join("\n")).not.toContain(marker);
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
  const token = "token" in run ? run.token : tokens.admin;
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: {
      ORCH_CONFIG: join(dir, "no-config.json"),
      ORCH_API_URL: api,
      ...(token ? { ORCH_TOKEN: token } : {}),
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
    commands: rotationCommands(),
  });
  quiet.push(...err, ...out);
  return { code, out, err, text: out.join("\n") };
}

const web = ["--org", "acme", "--project", "web"];
const dev = [...web, "--env", "dev"];
const prod = [...web, "--env", "prod"];
const org = ["--org", "acme", "--level", "org"];
const project = [...web, "--level", "project"];
const json = (o: { out: string[] }) => JSON.parse(o.out.join("\n"));

describe("orch rotation set", () => {
  test("sets a rotation on a variable of the environment and says when it is next due", async () => {
    const key = await make("env");
    const r = await orch([
      "rotation",
      "set",
      key,
      "--provider",
      "random",
      "--interval",
      "30",
      ...dev,
    ]);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.text).toContain(`acme/web/dev ${key}`);
    expect(r.text).toContain("random");
    expect(r.text).toContain("every 30 days");
    expect(r.text).toMatch(/next \d{4}-\d\d-\d\dT/);
  });

  test("--json prints the rotation as the API holds it: no config, no value", async () => {
    const key = await make("env");
    const r = await orch([
      "--json",
      "rotation",
      "set",
      key,
      "--provider",
      "random",
      "--interval",
      "7",
      "--grace",
      "2",
      "--config",
      '{"length":40,"alphabet":"hex"}',
      ...dev,
    ]);
    const doc = json(r);
    expect(doc).toMatchObject({
      provider: "random",
      intervalDays: 7,
      graceDays: 2,
      enabled: true,
      lastStatus: "never",
      revokePending: false,
    });
    expect(Object.keys(doc)).not.toContain("config");
    expect(r.text).not.toContain("alphabet");
  });

  test("--disabled sets it switched off; setting again replaces the whole setting", async () => {
    const key = await make("env");
    const set = (...extra: string[]) =>
      orch(["--json", "rotation", "set", key, "--provider", "random", ...extra, ...dev]);
    expect(json(await set("--interval", "10", "--disabled")).enabled).toBe(false);
    const again = json(await set("--interval", "20"));
    expect(again).toMatchObject({ intervalDays: 20, enabled: true });
  });

  test("works at the project and the organization level with --level", async () => {
    const pk = await make("project");
    const ok = await make("org");
    const a = await orch([
      "rotation",
      "set",
      pk,
      "--provider",
      "random",
      "--interval",
      "5",
      ...project,
    ]);
    expect(a.err).toEqual([]);
    expect(a.text).toContain(`acme/web ${pk}`);
    const b = await orch([
      "rotation",
      "set",
      ok,
      "--provider",
      "random",
      "--interval",
      "5",
      ...org,
    ]);
    expect(b.err).toEqual([]);
    expect(b.text).toContain(`acme ${ok}`);
    // the key is looked for at the level asked for, and only there
    const wrong = await orch(["rotation", "show", pk, ...dev]);
    expect(wrong.code).toBe(2);
    expect(wrong.err.join()).toContain(`no variable '${pk}'`);
  });

  test("a bad setting is a usage error before anything is sent; the config is never echoed", async () => {
    const key = await make("env");
    const set = (...extra: string[]) => orch(["rotation", "set", key, ...extra, ...dev]);
    for (const bad of [
      ["--interval", "30"], // no provider
      ["--provider", "random"], // no interval
      ["--provider", "random", "--interval", "soon"],
      ["--provider", "random", "--interval", "2.5"],
      ["--provider", "random", "--interval", "30", "--grace", "-1"],
      ["--provider", "random", "--interval", "30", "--level", "galaxy"],
    ]) {
      const r = await set(...bad);
      expect(r.code).toBe(2);
      expect(r.out).toEqual([]);
    }
    for (const config of ["{not json", "[1,2]", '"text"', "null"]) {
      const r = await set("--provider", "random", "--interval", "30", "--config", config);
      expect(r.code).toBe(2);
      expect(r.err.join()).toContain("--config");
      expect(r.err.join()).not.toContain("not json");
    }
  });

  test("what the API refuses is said as the API says it", async () => {
    const plain = await make("env", "plain");
    const a = await orch([
      "rotation",
      "set",
      plain,
      "--provider",
      "random",
      "--interval",
      "30",
      ...dev,
    ]);
    expect(a.code).toBe(1);
    expect(a.err.join()).toContain("not_secret");
    const key = await make("env");
    const b = await orch([
      "rotation",
      "set",
      key,
      "--provider",
      "nope",
      "--interval",
      "30",
      ...dev,
    ]);
    expect(b.code).toBe(1);
    expect(b.err.join()).toContain("unknown_provider");
    const c = await orch([
      "rotation",
      "set",
      key,
      "--provider",
      "random",
      "--interval",
      "30",
      "--config",
      '{"length":1}',
      ...dev,
    ]);
    expect(c.code).toBe(1);
    expect(c.err.join()).toContain("invalid_config");
  });

  test("a reader may look but not change", async () => {
    const key = await make("env");
    await orch(["rotation", "set", key, "--provider", "random", "--interval", "30", ...dev]);
    const read = await orch(["rotation", "show", key, ...dev], { token: tokens.reporter });
    expect(read.code).toBe(0);
    const write = await orch(
      ["rotation", "set", key, "--provider", "random", "--interval", "9", ...dev],
      {
        token: tokens.reporter,
      },
    );
    expect(write.code).toBe(1);
    expect(write.out).toEqual([]);
  });
});

describe("orch rotation show", () => {
  test("a variable with no rotation says so, and so does a key that is not there", async () => {
    const key = await make("env");
    const none = await orch(["rotation", "show", key, ...dev]);
    expect(none.code).toBe(1);
    expect(none.err.join()).toContain("Rotation not found");
    const gone = await orch(["rotation", "show", "NOT_THERE", ...dev]);
    expect(gone.code).toBe(2);
    expect(gone.err.join()).toContain("no variable 'NOT_THERE'");
  });

  test("prints the provider, schedule and last result, one fact a line", async () => {
    const key = await make("env");
    await orch([
      "rotation",
      "set",
      key,
      "--provider",
      "random",
      "--interval",
      "30",
      "--grace",
      "3",
      ...dev,
    ]);
    const r = await orch(["rotation", "show", key, ...dev]);
    expect(r.code).toBe(0);
    const lines = r.text.split("\n");
    expect(lines[0]).toBe(`acme/web/dev ${key}`);
    expect(lines.slice(1).map((l) => l.replace(/\s+/g, " "))).toEqual([
      "provider random",
      "interval 30 days, grace 3 days",
      "enabled yes",
      expect.stringMatching(/^next \d{4}-/),
      "last never rotated",
    ]);
  });

  test("after a rotation it shows when and with what result", async () => {
    const key = await make("env");
    await orch(["rotation", "set", key, "--provider", "random", "--interval", "30", ...dev]);
    await orch(["rotation", "run", key, "--yes", ...dev]);
    const r = await orch(["rotation", "show", key, ...dev]);
    expect(r.text).toMatch(/last +\d{4}-\d\d-\d\dT[\d:.]+Z ok/);
    const doc = json(await orch(["--json", "rotation", "show", key, ...dev]));
    expect(doc).toMatchObject({ lastStatus: "ok", attempts: 0, lastError: null });
  });
});

describe("orch rotation run", () => {
  test("asks first, because the old value stops being the variable's; no terminal, no run", async () => {
    const key = await make("env");
    await orch(["rotation", "set", key, "--provider", "random", "--interval", "30", ...dev]);
    asked.length = 0;

    const noTerminal = await orch(["rotation", "run", key, ...dev]);
    expect(noTerminal.code).toBe(2);
    const no = await orch(["rotation", "run", key, ...dev], { answer: false });
    expect(no.code).toBe(1);
    expect(no.err.join()).toContain("cancelled");
    expect(asked[0]).toContain(`${key} in acme/web/dev`);
    expect(await stored("env", key)).toBe(OLD);

    const yes = await orch(["rotation", "run", key, ...dev], { answer: true });
    expect(yes.code).toBe(0);
    expect(await stored("env", key)).not.toBe(OLD);
  });

  test("--yes rotates; the answer names the new version and never the value", async () => {
    const key = await make("env");
    await orch([
      "rotation",
      "set",
      key,
      "--provider",
      "random",
      "--interval",
      "30",
      "--config",
      '{"length":48,"alphabet":"hex"}',
      ...dev,
    ]);
    const r = await orch(["rotation", "run", key, "--yes", ...dev]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`rotated: ${key} in acme/web/dev is now version 2`]);
    const value = await stored("env", key);
    expect(value).toMatch(/^[0-9a-f]{48}$/); // the config reached the provider
    secrets.push(value);
    expect(r.text).not.toContain(value);
    expect(r.err).toEqual([]);

    const doc = json(await orch(["--json", "rotation", "run", key, "--yes", ...dev]));
    expect(doc).toEqual({ result: "rotated", version: 3, target: "acme/web/dev", key });
    const latest = await stored("env", key);
    secrets.push(latest);
    expect(JSON.stringify(doc)).not.toContain(latest);
  });

  test("on a protected environment the new value waits for approval in a change request", async () => {
    const key = await make("prod");
    await orch(["rotation", "set", key, "--provider", "random", "--interval", "30", ...prod]);
    const r = await orch(["rotation", "run", key, "--yes", ...prod]);
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(
      new RegExp(
        `^waiting: ${key} in acme/web/prod: change request [0-9a-f-]{36} holds the new value$`,
      ),
    );
    const doc = json(await orch(["--json", "rotation", "run", key, "--yes", ...prod]));
    expect(doc.result).toBe("waiting");
    expect(doc.changeRequestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("a variable with no rotation is an error, nothing is rotated", async () => {
    const key = await make("env");
    const r = await orch(["rotation", "run", key, "--yes", ...dev]);
    expect(r.code).toBe(1);
    expect(r.err.join()).toContain("Rotation not found");
    expect(await stored("env", key)).toBe(OLD);
  });

  test("a provider that fails is reported by its code, and the value stays", async () => {
    const key = await make("env");
    await orch(["rotation", "set", key, "--provider", "random", "--interval", "30", ...dev]);
    // a stored config the provider can no longer read: written below the API's own check
    const [row] = await t.db
      .select({ id: variables.id })
      .from(variables)
      .where(eq(variables.key, key));
    await t.db
      .update(variableRotations)
      .set({ config: { length: 1 } })
      .where(eq(variableRotations.variableId, row?.id ?? ""));
    const r = await orch(["rotation", "run", key, "--yes", ...dev]);
    expect(r.code).toBe(1);
    expect(r.err.join()).toContain("invalid_config");
    expect(await stored("env", key)).toBe(OLD);
  });
});

describe("orch rotation rm", () => {
  test("removes the rotation", async () => {
    const key = await make("env");
    await orch(["rotation", "set", key, "--provider", "random", "--interval", "30", ...dev]);
    const r = await orch(["rotation", "rm", key, ...dev]);
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`removed the rotation of ${key} in acme/web/dev`]);
  });

  test("--json says what was removed; a second removal is the API's not-found", async () => {
    const key = await make("env");
    await orch(["rotation", "set", key, "--provider", "random", "--interval", "30", ...dev]);
    const doc = json(await orch(["--json", "rotation", "rm", key, ...dev]));
    expect(doc).toEqual({ removed: true, target: "acme/web/dev", key });
    const again = await orch(["rotation", "rm", key, ...dev]);
    expect(again.code).toBe(1);
    expect(again.err.join()).toContain("Rotation not found");
    expect((await orch(["rotation", "show", key, ...dev])).code).toBe(1);
  });
});

describe("usage", () => {
  test("a step and a key are needed, and nothing else", async () => {
    for (const argv of [
      ["rotation"],
      ["rotation", "show"],
      ["rotation", "show", "A", "B"],
      ["rotation", "launch", "A"],
      ["rotation", "show", "A", "--provider", "random"],
      ["rotation", "run", "A", "--interval", "3"],
    ]) {
      const r = await orch([...argv, ...dev]);
      expect(r.code).toBe(2);
      expect(r.err.join()).toContain("usage: orch rotation");
    }
  });

  test("not signed in is said before anything is looked up", async () => {
    const r = await orch(["rotation", "show", "A", ...dev], { token: undefined });
    expect(r.code).toBe(1);
    expect(r.err.join()).toContain("not signed in");
  });
});
