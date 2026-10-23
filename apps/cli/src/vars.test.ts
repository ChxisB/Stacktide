// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${KEY}` is the reference syntax under test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { newApiToken } from "@orch/api/tokens";
import { createLogger, parseDotenv, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createApiToken,
  createEnvironment,
  createOrganization,
  createProject,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { CliError, runCli } from "./cli";
import { PROJECT_FILE } from "./project";
import { varsCommands } from "./vars";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);

let t: TestDb;
let app: ReturnType<typeof makeApp>;
let api: string;
let dir: string;
const ids = {} as Record<
  "org" | "web" | "other" | "dev" | "stage" | "prod" | "bare" | "nul",
  string
>;
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

/** Every value that must never reach a terminal except as the answer to `pull` and `export`. */
const secrets: string[] = [];
const sekrit = (label: string) => {
  const marker = `SEKRIT-${label}-${Bun.randomUUIDv7()}`;
  secrets.push(marker);
  return marker;
};
/** What the commands printed where no value may appear. */
const quiet: string[] = [];

const dbPassword = sekrit("db-password");
const orgToken = sekrit("org-token");
const certificate = `-----BEGIN-----\n${sekrit("cert")}\n-----END-----`;
const tricky = `it's "quoted" $HOME \`x\`\n#line2 \\n end `;

beforeAll(async () => {
  t = await createTestDb();
  ids.org = (await createOrganization(t.db, { slug: "acme", name: "Acme Inc" })).id;
  const project = async (name: string) =>
    (await createProject(t.db, { organizationId: ids.org, name })).id;
  ids.web = await project("web");
  ids.other = await project("other");
  const env = async (projectId: string, slug: string) =>
    (await createEnvironment(t.db, { organizationId: ids.org, projectId, name: slug, slug })).id;
  ids.dev = await env(ids.web, "dev");
  ids.stage = await env(ids.web, "stage");
  ids.prod = await env(ids.web, "prod");
  ids.nul = await env(ids.web, "nul");

  let gitlabId = 800;
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
  // an organization with nothing in it: the resolved set of its one environment is empty
  const bare = await createOrganization(t.db, { slug: "bare", name: "Bare" });
  ids.bare = bare.id;
  const bareProject = await createProject(t.db, { organizationId: bare.id, name: "p" });
  await createEnvironment(t.db, {
    organizationId: bare.id,
    projectId: bareProject.id,
    name: "e",
    slug: "e",
  });
  roleTable.set(801, { orgRoles: { [ids.org]: "admin", [bare.id]: "admin" }, projectRoles: {} });
  roleTable.set(802, {
    orgRoles: { [ids.org]: "member" },
    projectRoles: { [ids.web]: "maintainer" },
  });
  roleTable.set(803, {
    orgRoles: { [ids.org]: "member" },
    projectRoles: { [ids.web]: "reporter" },
  });

  app = makeApp().listen({ port: 0, hostname: "127.0.0.1" });
  api = `http://127.0.0.1:${app.server?.port}`;
  dir = await mkdtemp(join(tmpdir(), "orch-vars-"));

  const set = async (path: string, key: string, kind: string, value: string) => {
    const res = await fetch(`${api}${path}/variables`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" },
      body: JSON.stringify({ key, kind, value }),
    });
    expect(res.status).toBe(201);
  };
  const o = `/organizations/${ids.org}`;
  const p = `${o}/projects/${ids.web}`;
  await set(o, "REGION", "plain", "eu-west-1");
  await set(o, "ORG_TOKEN", "secret", orgToken);
  await set(p, "DB_USER", "plain", "app");
  await set(p, "DB_PASSWORD", "secret", "placeholder");
  await set(p, "DB_URL", "plain", "postgres://${DB_USER}:${DB_PASSWORD}@db/${REGION}");
  await set(`${p}/environments/${ids.dev}`, "DB_PASSWORD", "secret", dbPassword);
  await set(`${p}/environments/${ids.dev}`, "TRICKY", "plain", tricky);
  await set(`${p}/environments/${ids.dev}`, "TLS_CERT", "file", certificate);
  await set(`${p}/environments/${ids.prod}`, "BROKEN", "plain", "x${NOT_THERE}y");
  await set(`${p}/environments/${ids.prod}`, "FINE", "plain", "1");
  await set(`${p}/environments/${ids.nul}`, "NULLY", "plain", "a\u0000b");
});
afterAll(async () => {
  await app.stop(true);
  await t.drop();
  await rm(dir, { recursive: true, force: true });
  // nothing that was meant to stay quiet held a secret, in any test
  for (const marker of secrets) expect(quiet.join("\n")).not.toContain(marker);
});

interface Run {
  token?: string | undefined;
  cwd?: string;
  stdin?: string;
  /** Answers `confirm`; without it there is no terminal to ask. */
  answer?: boolean;
  env?: Record<string, string | undefined>;
  /** `pull` and `export` print values on purpose; their stdout is not checked for them. */
  prints?: boolean;
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
      ...run.env,
    },
    cwd: run.cwd ?? dir,
    home: dir,
    stdin: async () => run.stdin ?? "",
    open: async () => {},
    confirm: async (question) => {
      asked.push(question);
      if (run.answer === undefined) {
        throw new CliError("cannot ask for confirmation without a terminal; pass --yes", 2);
      }
      return run.answer;
    },
    version: "0.0.0",
    commands: varsCommands(),
  });
  quiet.push(...err, ...(run.prints ? [] : out));
  return { code, out, err };
}

const at = (env: string, extra: string[] = []) => [
  "--org",
  "acme",
  "--project",
  "web",
  "--env",
  env,
  ...extra,
];
const dev = (extra: string[] = []) => at("dev", extra);
const read = { prints: true } as const;

/** The variables of an environment as the API lists them: key to kind (a secret's value is never listed). */
async function held(envId: string) {
  const res = await fetch(
    `${api}/organizations/${ids.org}/projects/${ids.web}/environments/${envId}/variables?limit=100`,
    { headers: { authorization: `Bearer ${tokens.admin}` } },
  );
  const body = (await res.json()) as { items: { key: string; kind: string }[] };
  return Object.fromEntries(body.items.map((i) => [i.key, i.kind]));
}
/** The value the API holds for a key (the revealing route). */
async function storedValue(envId: string, key: string) {
  const list = await fetch(
    `${api}/organizations/${ids.org}/projects/${ids.web}/environments/${envId}/variables?limit=100`,
    { headers: { authorization: `Bearer ${tokens.admin}` } },
  );
  const item = ((await list.json()) as { items: { id: string; key: string }[] }).items.find(
    (i) => i.key === key,
  );
  const res = await fetch(
    `${api}/organizations/${ids.org}/projects/${ids.web}/environments/${envId}/variables/${item?.id}/value`,
    { headers: { authorization: `Bearer ${tokens.admin}` } },
  );
  return ((await res.json()) as { value: string }).value;
}

const expectedDev = {
  REGION: "eu-west-1",
  ORG_TOKEN: orgToken,
  DB_USER: "app",
  DB_PASSWORD: dbPassword,
  DB_URL: `postgres://app:${dbPassword}@db/eu-west-1`,
  TRICKY: tricky,
  TLS_CERT: certificate,
};

describe("pull and export", () => {
  test("pull writes the resolved set as a .env that reads back exactly", async () => {
    const res = await orch(["pull", ...dev()], read);
    expect(res.code).toBe(0);
    expect(res.err).toEqual([]);
    const parsed = parseDotenv(res.out.join("\n"));
    expect(parsed.issues).toEqual([]);
    expect(Object.fromEntries(parsed.entries.map((e) => [e.key, e.value]))).toEqual(expectedDev);
  });

  test("export is shell: a real shell reads every value back exactly", async () => {
    const res = await orch(["export", ...dev()], read);
    expect(res.code).toBe(0);
    const script = `${res.out.join("\n")}\nexec "$0" -e 'process.stdout.write(JSON.stringify(process.env))'`;
    const proc = Bun.spawn(["sh", "-c", script, process.execPath], {
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const env = JSON.parse(await new Response(proc.stdout).text()) as Record<string, string>;
    expect(await proc.exited).toBe(0);
    for (const [key, value] of Object.entries(expectedDev)) expect(env[key]).toBe(value);
  });

  test("--format and --json choose json; an unknown format is a usage error", async () => {
    const asJson = await orch(["pull", ...dev(["--format", "json"])], read);
    expect(JSON.parse(asJson.out.join("\n"))).toEqual(expectedDev);
    const global = await orch(["--json", "pull", ...dev()], read);
    expect(JSON.parse(global.out.join("\n"))).toEqual(expectedDev);
    const bad = await orch(["pull", ...dev(["--format", "yaml"])], read);
    expect(bad.code).toBe(2);
    expect(bad.err[0]).toContain("use dotenv, json, shell");
    expect(bad.out).toEqual([]);
  });

  test("names, slugs and ids all find the environment; .orch.json fills what flags leave out", async () => {
    const byId = await orch(
      ["pull", "--org", ids.org, "--project", ids.web, "--env", ids.dev, "--format", "json"],
      read,
    );
    expect(JSON.parse(byId.out.join("\n"))).toEqual(expectedDev);

    const work = join(dir, "checkout");
    await mkdir(work, { recursive: true });
    await writeFile(
      join(work, PROJECT_FILE),
      JSON.stringify({ organization: "acme", project: "web", environment: "dev" }),
    );
    const fromFile = await orch(["pull", "--format", "json"], { ...read, cwd: work });
    expect(JSON.parse(fromFile.out.join("\n"))).toEqual(expectedDev);
    // a flag wins over the file
    const flagged = await orch(["pull", "--env", "prod", "--ignore-issues", "--format", "json"], {
      ...read,
      cwd: work,
    });
    expect(JSON.parse(flagged.out.join("\n"))).toMatchObject({ FINE: "1", REGION: "eu-west-1" });

    // every flag wins over a file that names things that do not exist
    const wrong = join(dir, "wrong");
    await mkdir(wrong, { recursive: true });
    await writeFile(
      join(wrong, PROJECT_FILE),
      JSON.stringify({ organization: "nope", project: "nope", environment: "nope" }),
    );
    const allFlags = await orch(["pull", "--format", "json", ...dev()], { ...read, cwd: wrong });
    expect(JSON.parse(allFlags.out.join("\n"))).toEqual(expectedDev);
  });

  test("what is missing or unknown is said, with the known names and never a guess", async () => {
    const none = await orch(["pull", "--org", "acme"], read);
    expect(none.code).toBe(2);
    expect(none.err[0]).toContain("no project: pass --project");
    const noEnv = await orch(["pull", "--org", "acme", "--project", "web"], read);
    expect(noEnv.code).toBe(2);
    expect(noEnv.err[0]).toContain("no environment: pass --env");
    const nothing = await orch(["pull"], read);
    expect(nothing.err[0]).toContain("no organization: pass --org");

    const wrongOrg = await orch(
      ["pull", "--org", "acmee", "--project", "web", "--env", "dev"],
      read,
    );
    expect(wrongOrg.code).toBe(2);
    expect(wrongOrg.err[0]).toContain("no organization 'acmee'; known: acme");
    const wrongEnv = await orch(["pull", "--org", "acme", "--project", "web", "--env", "qa"], read);
    expect(wrongEnv.err[0]).toContain("no environment 'qa'; known: ");
    expect(wrongEnv.err[0]).toContain("dev");
    expect(wrongEnv.out).toEqual([]);
    const wrongId = await orch(
      ["pull", "--org", ids.org, "--project", ids.web, "--env", crypto.randomUUID()],
      read,
    );
    expect(wrongId.code).toBe(1);
    expect(wrongId.err[0]).toContain("not_found");
  });

  test("a name two organizations share is refused rather than guessed", async () => {
    const twins = [
      await createOrganization(t.db, { slug: "twin-a", name: "Twin" }),
      await createOrganization(t.db, { slug: "twin-b", name: "Twin" }),
    ];
    roleTable.set(801, {
      orgRoles: Object.fromEntries(
        [ids.org, ids.bare, ...twins.map((o) => o.id)].map((id) => [id, "admin"]),
      ),
      projectRoles: {},
    });
    const res = await orch(["pull", "--org", "Twin", "--project", "web", "--env", "dev"], read);
    expect(res.code).toBe(2);
    expect(res.err[0]).toContain("2 organizations are called 'Twin': use the id");
    expect(res.out).toEqual([]);
    // its slug is unique, so that finds it
    const bySlug = await orch(
      ["pull", "--org", "twin-a", "--project", "web", "--env", "dev"],
      read,
    );
    expect(bySlug.err[0]).toContain("no project 'web'");
  });

  test("an environment that does not resolve fails closed and names the keys, not the values", async () => {
    const res = await orch(["pull", ...at("prod")], read);
    expect(res.code).toBe(1);
    expect(res.out).toEqual([]);
    expect(res.err).toHaveLength(1);
    expect(res.err[0]).toContain("missing BROKEN");
    expect(res.err[0]).toContain("--ignore-issues");

    const partial = await orch(["pull", ...at("prod", ["--ignore-issues"])], read);
    expect(partial.code).toBe(0);
    expect(partial.err[0]).toContain("warning: left out 1");
    expect(partial.out.join("\n")).toContain("FINE=1");
    expect(partial.out.join("\n")).not.toContain("BROKEN");
  });

  test("the right to reveal is needed: a maintainer may, a reporter may not, and nothing is printed", async () => {
    const maintainer = await orch(["pull", ...dev(["--format", "json"])], {
      ...read,
      token: tokens.maintainer,
    });
    expect(maintainer.code).toBe(0);
    expect(JSON.parse(maintainer.out.join("\n"))).toEqual(expectedDev);

    const reporter = await orch(["pull", ...dev()], { ...read, token: tokens.reporter });
    expect(reporter.code).toBe(1);
    expect(reporter.out).toEqual([]);
    expect(reporter.err[0]).toContain("forbidden");
  });

  test("without a token, or with a wrong one, nothing is asked of the API beyond the sign-in hint", async () => {
    const anon = await orch(["pull", ...dev()], { ...read, token: undefined });
    expect(anon.code).toBe(1);
    expect(anon.err[0]).toContain("not signed in");
    const wrong = await orch(["pull", ...dev()], { ...read, token: newApiToken().token });
    expect(wrong.code).toBe(1);
    expect(wrong.err[0]).toContain("orch login");
    expect(wrong.out).toEqual([]);
  });

  test("an API that cannot be reached is said so, without the token", async () => {
    const res = await orch(["pull", ...dev()], {
      ...read,
      env: { ORCH_API_URL: "http://127.0.0.1:1" },
    });
    expect(res.code).toBe(1);
    expect(res.err[0]).toContain("cannot reach http://127.0.0.1:1");
    expect(res.err.join("\n")).not.toContain(tokens.admin);
  });

  test("extra words are a usage error", async () => {
    const res = await orch(["pull", "extra", ...dev()], read);
    expect(res.code).toBe(2);
    expect(res.out).toEqual([]);
  });
});

describe("pull --out", () => {
  const target = (name: string) => join(dir, name);

  test("writes a new file for this user only and says how many, not what", async () => {
    const path = target("a.env");
    const res = await orch(["pull", ...dev(["--out", "a.env"])], read);
    expect(res.code).toBe(0);
    expect(res.out).toEqual(["wrote 7 variables to a.env"]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    const parsed = parseDotenv(await readFile(path, "utf8"));
    expect(Object.fromEntries(parsed.entries.map((e) => [e.key, e.value]))).toEqual(expectedDev);
    quiet.push(...res.out);
  });

  test("an existing file is never replaced without --force, and is left as it was", async () => {
    const path = target("b.env");
    await writeFile(path, "KEEP=me\n");
    const res = await orch(["pull", ...dev(["--out", "b.env"])], read);
    expect(res.code).toBe(1);
    expect(res.err[0]).toBe("error: b.env exists; pass --force to replace it");
    expect(await readFile(path, "utf8")).toBe("KEEP=me\n");
  });

  test("--force replaces it with a file for this user only, whatever mode the old one had", async () => {
    const path = target("c.env");
    await writeFile(path, "OLD=1\n");
    await chmod(path, 0o644);
    const res = await orch(["pull", ...dev(["--out", "c.env", "--force"])], read);
    expect(res.code).toBe(0);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain("DB_USER=app");
    expect(await readFile(path, "utf8")).not.toContain("OLD");
  });

  test("a link at the path is never written through", async () => {
    const victim = target("victim.txt");
    await writeFile(victim, "untouched");
    await symlink(victim, target("link.env"));
    const refused = await orch(["pull", ...dev(["--out", "link.env"])], read);
    expect(refused.code).toBe(1);
    expect(await readFile(victim, "utf8")).toBe("untouched");
    const forced = await orch(["pull", ...dev(["--out", "link.env", "--force"])], read);
    expect(forced.code).toBe(0);
    expect(await readFile(victim, "utf8")).toBe("untouched");
    expect(await readFile(target("link.env"), "utf8")).toContain("DB_USER=app");
  });

  test("a failed pull leaves no file, and --json says what was written", async () => {
    const res = await orch(["pull", ...at("prod", ["--out", "d.env"])], read);
    expect(res.code).toBe(1);
    expect(await Bun.file(target("d.env")).exists()).toBe(false);
    const json = await orch(["--json", "pull", ...dev(["--out", "e.env"])], read);
    expect(JSON.parse(json.out[0] ?? "")).toEqual({ file: "e.env", count: 7 });
    expect((await stat(target("e.env"))).mode & 0o777).toBe(0o600);
  });

  test("a stale temporary file, even a link, is replaced and not written through", async () => {
    const victim = target("victim2.txt");
    await writeFile(victim, "untouched");
    await writeFile(target("f.env"), "OLD=1\n");
    await symlink(victim, `${target("f.env")}.${process.pid}.tmp`);
    const res = await orch(["pull", ...dev(["--out", "f.env", "--force"])], read);
    expect(res.code).toBe(0);
    expect(await readFile(victim, "utf8")).toBe("untouched");
    expect(await readFile(target("f.env"), "utf8")).toContain("DB_USER=app");
  });

  test("a replacement that fails leaves no temporary file behind", async () => {
    await mkdir(target("adir"), { recursive: true });
    await writeFile(join(target("adir"), "keep"), "x");
    const res = await orch(["pull", ...dev(["--out", "adir", "--force"])], read);
    expect(res.code).toBe(1);
    expect(res.err[0]).toBe("error: cannot write adir");
    expect(await Bun.file(`${target("adir")}.${process.pid}.tmp`).exists()).toBe(false);
  });

  test("a file for json is not mistaken for dotenv because --json was given", async () => {
    const res = await orch(["--json", "pull", ...dev(["--out", "g.env"])], read);
    expect(res.code).toBe(0);
    expect(parseDotenv(await readFile(target("g.env"), "utf8")).entries).toHaveLength(7);
  });

  test("an environment with nothing in it prints nothing and writes an empty file", async () => {
    const bare = ["--org", "bare", "--project", "p", "--env", "e"];
    const res = await orch(["pull", ...bare], read);
    expect(res).toEqual({ code: 0, out: [], err: [] });
    const out = await orch(["pull", ...bare, "--out", "h.env"], read);
    expect(out.code).toBe(0);
    expect(await readFile(target("h.env"), "utf8")).toBe("");
  });

  test("a path that cannot be written is an error that names the path", async () => {
    const res = await orch(["pull", ...dev(["--out", "no/such/dir/x.env"])], read);
    expect(res.code).toBe(1);
    expect(res.err[0]).toBe("error: cannot write no/such/dir/x.env");
  });
});

describe("push", () => {
  const file = async (name: string, text: string) => {
    await writeFile(join(dir, name), text);
    return name;
  };
  const noValues = (lines: string[]) => {
    for (const marker of secrets) expect(lines.join("\n")).not.toContain(marker);
  };

  test("--dry-run previews the keys and what would happen to them, and sends nothing", async () => {
    const value = sekrit("dry");
    const name = await file(
      "dry.env",
      `DRY_ONE=${value}\nDRY_TWO='${value} two'\n# note\nbad line\n`,
    );
    const res = await orch(["push", name, ...at("stage", ["--dry-run"])]);
    expect(res.code).toBe(0);
    expect(res.out).toEqual([
      "create        DRY_ONE (secret)",
      "create        DRY_TWO (secret)",
      "skipped       syntax (line 4)",
      "acme/web/stage: 2 to write, 0 unchanged, 0 in conflict, 1 skipped",
    ]);
    expect(await held(ids.stage)).toEqual({});
    expect(asked.join("\n")).not.toContain(value);
  });

  test("it asks first, shows no value in the question, and applies after a yes", async () => {
    const value = sekrit("ask");
    const name = await file("ask.env", `ASK_ONE=${value}\nASK_PLAIN=visible\n`);
    const before = asked.length;
    const res = await orch(["push", name, ...at("stage", ["--kind", "plain"])], { answer: true });
    expect(res.code).toBe(0);
    expect(asked.slice(before)).toEqual(["Apply 2 changes to acme/web/stage?"]);
    expect(res.out.at(-1)).toBe("acme/web/stage: 2 created, 0 updated");
    expect(await held(ids.stage)).toMatchObject({ ASK_ONE: "plain", ASK_PLAIN: "plain" });
    expect(await storedValue(ids.stage, "ASK_ONE")).toBe(value);
    noValues(res.out);
  });

  test("declining the question changes nothing", async () => {
    const name = await file("no.env", "NO_ONE=1\n");
    const res = await orch(["push", name, ...at("stage")], { answer: false });
    expect(res.code).toBe(1);
    expect(res.err[0]).toBe("error: cancelled; nothing was changed");
    expect(await held(ids.stage)).not.toHaveProperty("NO_ONE");
  });

  test("with no terminal and no --yes it refuses (exit 2) and changes nothing", async () => {
    const name = await file("noterm.env", "NOTERM=1\n");
    const res = await orch(["push", name, ...at("stage")]);
    expect(res.code).toBe(2);
    expect(res.err[0]).toContain("pass --yes");
    expect(await held(ids.stage)).not.toHaveProperty("NOTERM");
  });

  test("--yes applies at once, secret by default; the same file again is nothing to push", async () => {
    const value = sekrit("yes");
    const name = await file("yes.env", `YES_ONE=${value}\n`);
    const res = await orch(["push", name, ...at("stage", ["--yes"])]);
    expect(res.code).toBe(0);
    expect(res.out).toEqual([
      "create        YES_ONE (secret)",
      "acme/web/stage: 1 to write, 0 unchanged, 0 in conflict, 0 skipped",
      "acme/web/stage: 1 created, 0 updated",
    ]);
    expect(await held(ids.stage)).toMatchObject({ YES_ONE: "secret" });
    const again = await orch(["push", name, ...at("stage", ["--yes"])]);
    expect(again.code).toBe(0);
    // an unchanged key is counted, not listed
    expect(again.out).toEqual([
      "acme/web/stage: 0 to write, 1 unchanged, 0 in conflict, 0 skipped",
      "nothing to push",
    ]);
    noValues([...res.out, ...again.out]);
  });

  test("a different value is a conflict until --overwrite; with --yes a conflict stops everything", async () => {
    const first = sekrit("first");
    const second = sekrit("second");
    await orch(["push", await file("c1.env", `CONF=${first}\n`), ...at("stage", ["--yes"])]);
    const name = await file("c2.env", `CONF=${second}\nCONF_NEW=1\n`);

    const stopped = await orch(["push", name, ...at("stage", ["--yes"])]);
    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain(
      "conflict      CONF (secret) holds another value; --overwrite replaces it",
    );
    expect(stopped.err[0]).toContain("1 entries cannot be applied");
    expect(stopped.err[0]).toContain("nothing was changed");
    expect(await held(ids.stage)).not.toHaveProperty("CONF_NEW");
    expect(await storedValue(ids.stage, "CONF")).toBe(first);

    const replaced = await orch(["push", name, ...at("stage", ["--yes", "--overwrite"])]);
    expect(replaced.code).toBe(0);
    expect(replaced.out.at(-1)).toBe("acme/web/stage: 1 created, 1 updated");
    expect(await storedValue(ids.stage, "CONF")).toBe(second);
    noValues([...stopped.out, ...stopped.err, ...replaced.out]);
  });

  test("a file that only changes held values is applied, not called nothing to push", async () => {
    const first = sekrit("only1");
    const second = sekrit("only2");
    await orch(["push", await file("u1.env", `ONLY=${first}\n`), ...at("stage", ["--yes"])]);
    const res = await orch([
      "push",
      await file("u2.env", `ONLY=${second}\n`),
      ...at("stage", ["--yes", "--overwrite"]),
    ]);
    expect(res.code).toBe(0);
    expect(res.out.at(-1)).toBe("acme/web/stage: 0 created, 1 updated");
    expect(await storedValue(ids.stage, "ONLY")).toBe(second);
    noValues(res.out);
  });

  test("a key held with another kind is reported, and with --yes stops the push", async () => {
    await orch(["push", await file("k1.env", "KINDED=1\n"), ...at("stage", ["--yes"])]);
    const res = await orch([
      "push",
      await file("k2.env", "KINDED=1\nKIND_OK=1\n"),
      ...at("stage", ["--yes", "--kind", "plain"]),
    ]);
    expect(res.code).toBe(1);
    expect(res.out).toContain(
      "kind_mismatch KINDED (plain) is held with another kind, which cannot change",
    );
    expect(await held(ids.stage)).not.toHaveProperty("KIND_OK");
  });

  test("a line that cannot be read stops a --yes push, and is shown by line number only", async () => {
    const value = sekrit("badline");
    const name = await file("skip.env", `GOOD_ONE=1\nthis is not an assignment ${value}\n`);
    const res = await orch(["push", name, ...at("stage", ["--yes"])]);
    expect(res.code).toBe(1);
    expect(res.out).toContain("skipped       syntax (line 2)");
    expect(await held(ids.stage)).not.toHaveProperty("GOOD_ONE");
    // run by hand, the user sees the line and may go on without it
    const hand = await orch(["push", name, ...at("stage")], { answer: true });
    expect(hand.code).toBe(0);
    expect(await held(ids.stage)).toHaveProperty("GOOD_ONE");
    noValues([...res.out, ...res.err, ...hand.out]);
  });

  test("standard input and JSON files work; the format follows the extension", async () => {
    const piped = await orch(["push", "-", ...at("stage", ["--yes"])], { stdin: "PIPED=1\n" });
    expect(piped.code).toBe(0);
    expect(await held(ids.stage)).toHaveProperty("PIPED");
    const json = await orch([
      "push",
      await file("vars.json", '{"FROM_JSON":"j","N":3}'),
      ...at("stage", ["--yes"]),
    ]);
    expect(json.code).toBe(0);
    expect(await held(ids.stage)).toMatchObject({ FROM_JSON: "secret", N: "secret" });
    expect(await storedValue(ids.stage, "N")).toBe("3");
    // a .json name read as dotenv on request
    const forced = await orch([
      "push",
      await file("odd.json", "ODD=1\n"),
      ...at("stage", ["--yes", "--format", "dotenv"]),
    ]);
    expect(forced.code).toBe(0);
    expect(await held(ids.stage)).toHaveProperty("ODD");
  });

  test("--json prints one document with keys and kinds, never values", async () => {
    const value = sekrit("json");
    const res = await orch([
      "--json",
      "push",
      await file("j.env", `JSON_ONE=${value}\n`),
      ...at("stage", ["--yes"]),
    ]);
    expect(res.code).toBe(0);
    expect(res.out).toHaveLength(1);
    expect(JSON.parse(res.out[0] ?? "")).toEqual({
      environment: "acme/web/stage",
      applied: true,
      changes: [{ change: "create", key: "JSON_ONE", kind: "secret" }],
      skipped: [],
    });
    noValues(res.out);
  });

  test("usage errors: no file, a missing file, an empty file, a bad kind", async () => {
    expect((await orch(["push", ...at("stage")])).code).toBe(2);
    expect((await orch(["push", "none1.env", "none2.env", ...at("stage")])).code).toBe(2);
    const missing = await orch(["push", "nope.env", ...at("stage", ["--yes"])]);
    expect(missing.code).toBe(1);
    expect(missing.err[0]).toBe("error: cannot read nope.env");
    const empty = await orch(["push", await file("empty.env", ""), ...at("stage", ["--yes"])]);
    expect(empty.code).toBe(2);
    const emptyStdin = await orch(["push", "-", ...at("stage", ["--yes"])]);
    expect(emptyStdin.code).toBe(2);
    expect(emptyStdin.err[0]).toBe("error: standard input is empty");
    const big = await orch([
      "push",
      await file("big.env", `#${"x".repeat(1_048_576)}`),
      ...at("stage", ["--yes"]),
    ]);
    expect(big.code).toBe(2);
    expect(big.err[0]).toBe("error: big.env is larger than 1 MiB");
    // exactly 1 MiB is within the API's limit (a comment line: nothing to write)
    const edge = await orch([
      "push",
      await file("edge.env", `#${"x".repeat(1_048_575)}`),
      ...at("stage", ["--dry-run"]),
    ]);
    expect(edge.err).toEqual([]);
    expect(edge.out).toEqual(["acme/web/stage: 0 to write, 0 unchanged, 0 in conflict, 0 skipped"]);
    const kind = await orch(["push", "x.env", ...at("stage", ["--kind", "file"])]);
    expect(kind.code).toBe(2);
    expect(kind.err[0]).toContain("use plain, secret");
  });

  test("a project member who may not import is refused by the API, and nothing is sent twice", async () => {
    const res = await orch(["push", await file("rep.env", "REP=1\n"), ...at("stage", ["--yes"])], {
      token: tokens.reporter,
    });
    expect(res.code).toBe(1);
    expect(res.err[0]).toContain("forbidden");
    expect(await held(ids.stage)).not.toHaveProperty("REP");
  });
});

describe("run", () => {
  const bun = process.execPath;
  const file = (name: string) => join(dir, name);
  const exists = (path: string) => Bun.file(path).exists();
  const until = async (path: string) => {
    for (let i = 0; i < 200 && !(await exists(path)); i++) await Bun.sleep(50);
    expect(await exists(path)).toBe(true);
  };
  /** A command that writes `$1` to the file named by `$GOT`, to see what it was given. */
  const dumpEnv = "await Bun.write(process.env.GOT, JSON.stringify(process.env))";

  test("the command gets the resolved variables over its own environment, and its exit code is ours", async () => {
    const got = file("run-env.json");
    const res = await orch(["run", ...dev(), "--", bun, "-e", `${dumpEnv}; process.exit(7)`], {
      env: {
        GOT: got,
        KEEP: "mine",
        REGION: "from-the-parent",
        UNSET: undefined,
        ORCH_ID_TOKEN: "header.payload.signature",
      },
    });
    // the command writes its own output; orch adds nothing
    expect(res).toEqual({ code: 7, out: [], err: [] });
    const seen = JSON.parse(await readFile(got, "utf8"));
    expect(seen).toMatchObject(expectedDev);
    expect(seen.KEEP).toBe("mine");
    // the token that fetched the variables stays with orch; the API address is not a secret
    expect(seen).not.toHaveProperty("ORCH_TOKEN");
    // nor the job's id_token, which can be traded for a token until it expires
    expect(seen).not.toHaveProperty("ORCH_ID_TOKEN");
    expect(seen.ORCH_API_URL).toBe(api);
    // a name the parent has unset is not handed on as the text "undefined"
    expect(seen).not.toHaveProperty("UNSET");
  });

  test("--prefix hands each variable on under prefix + name, and under no other name", async () => {
    const got = file("run-prefix.json");
    const res = await orch(["run", ...dev(["--prefix", "TF_VAR_"]), "--", bun, "-e", dumpEnv], {
      env: {
        GOT: got,
        KEEP: "mine",
        TF_VAR_REGION: "from-the-parent",
        TF_VAR_ONLY_HERE: "from-the-parent",
        ORCH_ID_TOKEN: "header.payload.signature",
      },
    });
    expect(res).toEqual({ code: 0, out: [], err: [] });
    const seen = JSON.parse(await readFile(got, "utf8"));
    // the job's own TF_VAR_* (a CI/CD variable of the project) still reaches the command: only the platform's names are renamed
    expect(seen.TF_VAR_ONLY_HERE).toBe("from-the-parent");
    expect(seen).toMatchObject(
      Object.fromEntries(
        Object.entries(expectedDev).map(([key, value]) => [`TF_VAR_${key}`, value]),
      ),
    );
    // the platform's value wins over the parent's, as it does unprefixed; the parent's other names are not prefixed
    expect(seen.TF_VAR_REGION).toBe("eu-west-1");
    expect(seen.KEEP).toBe("mine");
    // each variable is there once, prefixed: none under its own name
    for (const key of Object.keys(expectedDev)) expect(seen).not.toHaveProperty(key);
    // the tokens are still withheld
    expect(seen).not.toHaveProperty("ORCH_TOKEN");
    expect(seen).not.toHaveProperty("ORCH_ID_TOKEN");
    expect(seen).not.toHaveProperty("TF_VAR_ORCH_TOKEN");
  });

  test("--prefix must be the start of an environment variable name: nothing runs otherwise", async () => {
    const got = file("run-bad-prefix.json");
    for (const prefix of ["", "1TF_", "TF VAR_", "TF=", "TF_VAR_\n", "é_", "A".repeat(65)]) {
      const res = await orch(["run", ...dev(["--prefix", prefix]), "--", bun, "-e", dumpEnv], {
        env: { GOT: got },
      });
      expect({ prefix, code: res.code }).toEqual({ prefix, code: 2 });
      expect(res.err[0]).toContain("--prefix");
    }
    expect(await exists(got)).toBe(false);
  });

  test("an exit code passes through, also one made by a signal", async () => {
    const run = (script: string) => orch(["run", ...dev(), "--", "sh", "-c", script]);
    expect((await run("exit 0")).code).toBe(0);
    expect((await run("exit 3")).code).toBe(3);
    expect((await run("kill -9 $$")).code).toBe(137);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${signal} reaches the command, whose answer is ours; nothing stays listening`, async () => {
      const ready = file(`ready-${signal}`);
      const got = file(`got-${signal}`);
      const before = process.listenerCount(signal);
      const script = `process.on("${signal}", async () => { await Bun.write(process.env.GOT, "${signal}"); process.exit(42); }); await Bun.write(process.env.READY, "1"); setInterval(() => {}, 1000);`;
      const running = orch(["run", ...dev(), "--", bun, "-e", script], {
        env: { READY: ready, GOT: got },
      });
      await until(ready);
      expect(process.listenerCount(signal)).toBe(before + 1);
      process.emit(signal, signal);
      expect((await running).code).toBe(42);
      expect(await readFile(got, "utf8")).toBe(signal);
      expect(process.listenerCount(signal)).toBe(before);
    });
  }

  test("nothing is written to disk by orch", async () => {
    const listing = async () => (await readdir(dir, { recursive: true })).sort();
    const before = await listing();
    // the command checks what it was given and writes nothing itself
    const res = await orch([
      "run",
      ...dev(),
      "--",
      "sh",
      "-c",
      'test "$DB_PASSWORD" = "$1" && test "$REGION" = eu-west-1',
      "sh",
      dbPassword,
    ]);
    expect(res).toEqual({ code: 0, out: [], err: [] });
    expect(await listing()).toEqual(before);
  });

  test("an environment that does not resolve never starts the command, unless told to take the rest", async () => {
    const got = file("prod-env.json");
    const refused = await orch(["run", ...at("prod"), "--", bun, "-e", dumpEnv], {
      env: { GOT: got },
    });
    expect(refused.code).toBe(1);
    expect(refused.err[0]).toContain("does not resolve (missing BROKEN)");
    expect(await exists(got)).toBe(false);

    const lenient = await orch(
      ["run", ...at("prod", ["--ignore-issues"]), "--", bun, "-e", dumpEnv],
      { env: { GOT: got } },
    );
    expect(lenient.code).toBe(0);
    expect(lenient.err[0]).toContain("warning: left out 1 that do not resolve (missing BROKEN)");
    const seen = JSON.parse(await readFile(got, "utf8"));
    expect(seen).toMatchObject({ FINE: "1", REGION: "eu-west-1" });
    expect(seen).not.toHaveProperty("BROKEN");
  });

  test("without the right to reveal, or a sign-in, or a value an environment can hold, the command never starts", async () => {
    const got = file("never.txt");
    const script = ["sh", "-c", 'echo ran > "$GOT"'];
    const reporter = await orch(["run", ...dev(), "--", ...script], {
      token: tokens.reporter,
      env: { GOT: got },
    });
    expect(reporter.code).toBe(1);
    expect(reporter.err[0]).toContain("forbidden");
    const signedOut = await orch(["run", ...dev(), "--", ...script], {
      token: undefined,
      env: { GOT: got },
    });
    expect(signedOut.code).toBe(1);
    expect(signedOut.err[0]).toBe("error: not signed in; run: orch login");
    const nul = await orch(["run", ...at("nul"), "--", ...script], { env: { GOT: got } });
    expect(nul.code).toBe(1);
    expect(nul.err[0]).toBe(
      "error: NULLY holds a NUL character, which an environment cannot carry",
    );
    expect(await exists(got)).toBe(false);
  });

  test("everything after the first -- is the command's: options, --json and --env included", async () => {
    const got = file("argv.txt");
    const res = await orch(
      [
        "run",
        ...dev(),
        "--",
        "sh",
        "-c",
        'printf "%s\\n" "$@" > "$GOT"',
        "sh",
        "--json",
        "--env",
        "prod",
        "-x",
        "--",
      ],
      { env: { GOT: got } },
    );
    expect(res.code).toBe(0);
    expect((await readFile(got, "utf8")).split("\n").slice(0, -1)).toEqual([
      "--json",
      "--env",
      "prod",
      "-x",
      "--",
    ]);
  });

  test("the command starts in the directory orch was run from", async () => {
    const work = file("work");
    await mkdir(work, { recursive: true });
    const got = file("cwd.txt");
    await orch(["run", ...dev(), "--", "sh", "-c", 'pwd -P > "$GOT"'], {
      cwd: work,
      env: { GOT: got },
    });
    expect((await readFile(got, "utf8")).trim()).toBe(await realpath(work));
  });

  test("a command that is missing or not allowed to run is said, with the shell's exit codes", async () => {
    const missing = await orch(["run", ...dev(), "--", "orch-no-such-command"]);
    expect(missing.code).toBe(127);
    expect(missing.err).toEqual(["error: cannot run 'orch-no-such-command': not found"]);
    const plain = file("not-executable");
    await writeFile(plain, "echo hi\n", { mode: 0o644 });
    const denied = await orch(["run", ...dev(), "--", plain]);
    expect(denied.code).toBe(126);
    expect(denied.err).toEqual([`error: cannot run '${plain}': not permitted`]);
  });

  describe("through the real entry point", () => {
    const main = join(import.meta.dir, "main.ts");
    const start = (args: string[], extra: Record<string, string> = {}, stdin?: Response) =>
      Bun.spawn([bun, main, "run", ...dev(), "--", ...args], {
        env: {
          PATH: process.env.PATH ?? "",
          HOME: dir,
          ORCH_CONFIG: join(dir, "no-config.json"),
          ORCH_API_URL: api,
          ORCH_TOKEN: tokens.admin,
          ...extra,
        },
        stdin: stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

    test("the command's own streams and exit code are the process's", async () => {
      const proc = start(
        ["sh", "-c", "cat; echo out-$REGION; echo err-$REGION >&2; exit 5"],
        {},
        new Response("piped in\n"),
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ out, err, code }).toEqual({
        out: "piped in\nout-eu-west-1\n",
        err: "err-eu-west-1\n",
        code: 5,
      });
    });

    test("a real SIGTERM sent to orch reaches the command", async () => {
      const ready = file("real-ready");
      const got = file("real-got");
      const script = `process.on("SIGTERM", async () => { await Bun.write(process.env.GOT, "term"); process.exit(42); }); await Bun.write(process.env.READY, "1"); setInterval(() => {}, 1000);`;
      const proc = start([bun, "-e", script], { READY: ready, GOT: got });
      await until(ready);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(42);
      expect(await readFile(got, "utf8")).toBe("term");
    });
  });

  test("usage: the command must follow a --, and orch's own words must be options", async () => {
    for (const argv of [
      ["run", ...dev(), "true"],
      ["run", ...dev(), "--"],
      ["run", ...dev(["stray"]), "--", "true"],
      ["run", "--bogus", "--", "true"],
      ["run"],
    ]) {
      const res = await orch(argv);
      expect({ argv, code: res.code }).toEqual({ argv, code: 2 });
      expect(res.out).toEqual([]);
    }
  });
});

describe("folders (FLD-10)", () => {
  const bun = process.execPath;
  const base = () => `/organizations/${ids.org}/projects/${ids.web}`;
  const file = (name: string) => join(dir, name);
  const dumpEnv = "await Bun.write(process.env.GOT, JSON.stringify(process.env))";
  const paySecret = sekrit("pay-secret");
  const inPayments = { PAY_KEY: "pk-1", PAY_URL: "https://pk-1.example", PAY_SECRET: paySecret };
  const project = (extra: string[] = []) => ["--org", "acme", "--project", "web", ...extra];

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${api}${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens.admin}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  /** The keys and kinds an environment holds in one folder, as the API lists them. */
  async function heldIn(envId: string, folder: string) {
    const res = await send(
      "GET",
      `${base()}/environments/${envId}/variables?limit=100&folder=${encodeURIComponent(folder)}`,
    );
    const body = (await res.json()) as { items: { key: string; kind: string }[] };
    return Object.fromEntries(body.items.map((i) => [i.key, i.kind]));
  }
  const names = async () => {
    const res = await send("GET", `${base()}/folders`);
    return ((await res.json()) as { items: { path: string }[] }).items.map((f) => f.path);
  };

  beforeAll(async () => {
    for (const [parent, name] of [
      [undefined, "payments"],
      ["/payments", "eu"],
      ["/payments", "bad"],
      [undefined, "empty"],
    ]) {
      expect((await send("POST", `${base()}/folders`, { parent, name })).status).toBe(201);
    }
    const set = async (path: string, folder: string, key: string, kind: string, value: string) =>
      expect((await send("POST", `${path}/variables`, { folder, key, kind, value })).status).toBe(
        201,
      );
    await set(base(), "/payments", "PAY_KEY", "plain", "pk-1");
    await set(base(), "/payments", "PAY_URL", "plain", "https://${PAY_KEY}.example");
    await set(`${base()}/environments/${ids.dev}`, "/payments", "PAY_SECRET", "secret", paySecret);
    await set(base(), "/payments/eu", "EU_ONLY", "plain", "eu");
    await set(base(), "/payments/bad", "BAD_REF", "plain", "x${MISSING}y");
  });

  const json = (res: { out: string[] }) => JSON.parse(res.out.join("\n"));

  test("pull and export read one folder: its own variables, not the root's and not a subfolder's", async () => {
    const pulled = await orch(
      ["pull", ...dev(["--folder", "/payments", "--format", "json"])],
      read,
    );
    expect(pulled.code).toBe(0);
    expect(json(pulled)).toEqual(inPayments);
    const exported = await orch(["export", ...dev(["--folder", "/payments/eu"])], read);
    expect(exported.out).toEqual(["export EU_ONLY='eu'"]);
    // `/` is the root, as no flag is
    const root = await orch(["pull", ...dev(["--folder", "/", "--format", "json"])], read);
    expect(json(root)).toEqual(expectedDev);
    const none = await orch(["pull", ...dev(["--format", "json"])], read);
    expect(json(none)).toEqual(expectedDev);
  });

  test("run --folder gives the command that folder's variables and not the root's; with no flag, the root's", async () => {
    const got = file("run-folder.json");
    const res = await orch(["run", ...dev(["--folder", "/payments"]), "--", bun, "-e", dumpEnv], {
      env: { GOT: got },
    });
    expect(res).toEqual({ code: 0, out: [], err: [] });
    const seen = JSON.parse(await readFile(got, "utf8"));
    expect(seen).toMatchObject(inPayments);
    for (const key of Object.keys(expectedDev)) expect(seen).not.toHaveProperty(key);
    expect(seen).not.toHaveProperty("EU_ONLY");

    const rootGot = file("run-root.json");
    const plain = await orch(["run", ...dev(), "--", bun, "-e", dumpEnv], {
      env: { GOT: rootGot },
    });
    expect(plain.code).toBe(0);
    const rootSeen = JSON.parse(await readFile(rootGot, "utf8"));
    expect(rootSeen).toMatchObject(expectedDev);
    for (const key of Object.keys(inPayments)) expect(rootSeen).not.toHaveProperty(key);
  });

  test("a folder that is not a path is a usage error; one that is not there is the API's answer", async () => {
    for (const folder of ["payments", "/Pay", "/a//b", "/payments/", ""]) {
      for (const command of ["pull", "export"]) {
        const res = await orch([command, ...dev(["--folder", folder])], read);
        expect({ command, folder, code: res.code }).toEqual({ command, folder, code: 2 });
        expect(res.err[0]).toContain("--folder");
        expect(res.out).toEqual([]);
      }
    }
    const run = await orch(["run", ...dev(["--folder", "payments"]), "--", "true"]);
    expect(run.code).toBe(2);
    const gone = await orch(["pull", ...dev(["--folder", "/nope"])], read);
    expect(gone.code).toBe(1);
    expect(gone.err).toEqual(["error: Folder not found (not_found)"]);
    expect(gone.out).toEqual([]);
  });

  test("a folder that does not resolve fails closed, names the folder and the key, and leaves the others alone", async () => {
    const res = await orch(["pull", ...dev(["--folder", "/payments/bad"])], read);
    expect(res.code).toBe(1);
    expect(res.out).toEqual([]);
    expect(res.err[0]).toContain(
      "acme/web/dev:/payments/bad does not resolve (missing BROKEN".replace("BROKEN", "BAD_REF"),
    );
    const partial = await orch(
      ["pull", ...dev(["--folder", "/payments/bad", "--ignore-issues"])],
      read,
    );
    expect(partial.code).toBe(0);
    expect(partial.out).toEqual([]);
    expect(partial.err[0]).toContain("warning: left out 1");
  });

  describe("push --folder", () => {
    const put = async (name: string, text: string) => {
      await writeFile(file(name), text);
      return name;
    };

    test("previews, asks and imports into that folder, and the root is untouched", async () => {
      const value = sekrit("folder-push");
      const name = await put("fp.env", `FP_ONE=${value}\nFP_PLAIN=visible\n`);
      const dry = await orch([
        "push",
        name,
        ...at("stage", ["--folder", "/payments", "--dry-run"]),
      ]);
      expect(dry.out).toEqual([
        "create        /payments/FP_ONE (secret)",
        "create        /payments/FP_PLAIN (secret)",
        "acme/web/stage:/payments: 2 to write, 0 unchanged, 0 in conflict, 0 skipped",
      ]);
      expect(await heldIn(ids.stage, "/payments")).not.toHaveProperty("FP_ONE");

      const before = asked.length;
      const res = await orch(["push", name, ...at("stage", ["--folder", "/payments"])], {
        answer: true,
      });
      expect(res.code).toBe(0);
      expect(asked.slice(before)).toEqual(["Apply 2 changes to acme/web/stage:/payments?"]);
      expect(res.out.at(-1)).toBe("acme/web/stage:/payments: 2 created, 0 updated");
      expect(await heldIn(ids.stage, "/payments")).toMatchObject({
        FP_ONE: "secret",
        FP_PLAIN: "secret",
      });
      expect(await heldIn(ids.stage, "/")).not.toHaveProperty("FP_ONE");
      expect(await held(ids.stage)).not.toHaveProperty("FP_PLAIN");
      const back = await orch(
        ["pull", ...at("stage", ["--folder", "/payments", "--format", "json"])],
        read,
      );
      expect(json(back)).toMatchObject({ FP_ONE: value, FP_PLAIN: "visible" });
      const root = await orch(["pull", ...at("stage", ["--format", "json"])], read);
      expect(json(root)).not.toHaveProperty("FP_ONE");
    });

    test("--json names the folder; at the root the document has none", async () => {
      const name = await put("fj.env", "FJ_ONE=1\n");
      const res = await orch([
        "--json",
        "push",
        name,
        ...at("stage", ["--folder", "/payments", "--yes"]),
      ]);
      expect(res.code).toBe(0);
      expect(JSON.parse(res.out.at(-1) ?? "")).toEqual({
        environment: "acme/web/stage",
        folder: "/payments",
        applied: true,
        changes: [{ change: "create", key: "FJ_ONE", kind: "secret" }],
        skipped: [],
      });
      const rootName = await put("fr.env", "FJ_ROOT=1\n");
      const root = await orch(["--json", "push", rootName, ...at("stage", ["--yes"])]);
      expect(JSON.parse(root.out.at(-1) ?? "")).not.toHaveProperty("folder");
    });

    test("a bad or missing folder changes nothing", async () => {
      const name = await put("fb.env", "FB_ONE=1\n");
      const bad = await orch(["push", name, ...at("stage", ["--folder", "nope", "--yes"])]);
      expect(bad.code).toBe(2);
      const missing = await orch(["push", name, ...at("stage", ["--folder", "/nope", "--yes"])]);
      expect(missing.code).toBe(1);
      expect(missing.err[0]).toContain("not_found");
      expect(await heldIn(ids.stage, "/")).not.toHaveProperty("FB_ONE");
    });
  });

  describe("orch folders", () => {
    test("list prints the paths from the root down, and --json the ids too", async () => {
      const res = await orch(["folders", "list", ...project()]);
      expect(res.code).toBe(0);
      expect(res.out).toEqual(["/empty\n/payments\n/payments/bad\n/payments/eu"]);
      const asJson = await orch(["--json", "folders", "list", ...project()]);
      const doc = JSON.parse(asJson.out.join("\n"));
      expect(doc.project).toBe("acme/web");
      expect(doc.folders.map((f: { path: string }) => f.path)).toEqual(
        (res.out[0] ?? "").split("\n"),
      );
      expect(doc.folders[0].id).toMatch(/^[0-9a-f-]{36}$/);
      const bare = await orch(["folders", "list", "--org", "bare", "--project", "p"]);
      expect(bare.out).toEqual(["no folders in bare/p"]);
    });

    test("create makes a folder under its parent; a missing parent, a taken name and a bad path are said", async () => {
      const made = await orch(["folders", "create", "/payments/us", ...project()]);
      expect(made.code).toBe(0);
      expect(made.out).toEqual(["created folder /payments/us in acme/web"]);
      const top = await orch(["folders", "create", "/billing", ...project()]);
      expect(top.code).toBe(0);
      expect(await names()).toEqual(expect.arrayContaining(["/billing", "/payments/us"]));
      const orphan = await orch(["folders", "create", "/nowhere/deep", ...project()]);
      expect(orphan.code).toBe(1);
      expect(orphan.err).toEqual(["error: Parent folder not found (not_found)"]);
      const taken = await orch(["folders", "create", "/payments/eu", ...project()]);
      expect(taken.code).toBe(1);
      expect(taken.err[0]).toContain("folder_taken");
      for (const path of ["/", "payments", "/Pay", "/a/b/c/d/e/f"]) {
        const bad = await orch(["folders", "create", path, ...project()]);
        expect({ path, code: bad.code }).toEqual({ path, code: 2 });
      }
      expect(await names()).not.toContain("/nowhere");
    });

    test("rm removes an empty folder; one with variables or folders in it prints the API's message, exits 1 and stays", async () => {
      const full = await orch(["folders", "rm", "/payments/eu", ...project()]);
      expect(full.code).toBe(1);
      expect(full.err).toEqual([
        "error: A folder with variables or folders in it cannot be deleted: empty it first (folder_not_empty)",
      ]);
      const parent = await orch(["folders", "rm", "/payments", ...project()]);
      expect(parent.code).toBe(1);
      expect(parent.err[0]).toContain("folder_not_empty");
      expect(await names()).toEqual(expect.arrayContaining(["/payments", "/payments/eu"]));

      const gone = await orch(["folders", "rm", "/empty", ...project()]);
      expect(gone.code).toBe(0);
      expect(gone.out).toEqual(["removed folder /empty from acme/web"]);
      expect(await names()).not.toContain("/empty");
      const again = await orch(["folders", "rm", "/empty", ...project()]);
      expect(again.code).toBe(2);
      expect(again.err[0]).toContain("no folder '/empty'; known: /billing");
      // a path is the whole path: /pay is not /payments
      const prefix = await orch(["folders", "rm", "/pay", ...project()]);
      expect(prefix.code).toBe(2);
      expect(prefix.err[0]).toContain("no folder '/pay'");
      expect(await names()).toContain("/payments");
    });

    test("usage: a step, one path where one is wanted, and no flag that does nothing", async () => {
      for (const argv of [
        ["folders"],
        ["folders", "bogus"],
        ["folders", "bogus", "/payments/eu", ...project()],
        ["folders", "list", "/payments", ...project()],
        ["folders", "create", ...project()],
        ["folders", "create", "/a", "/b", ...project()],
        ["folders", "rm", ...project()],
        ["folders", "list", ...project(["--folder", "/payments"])],
      ]) {
        const res = await orch(argv);
        expect({ argv, code: res.code }).toEqual({ argv, code: 2 });
      }
    });

    test("a reporter reads the tree and may not change it", async () => {
      const read = await orch(["folders", "list", ...project()], { token: tokens.reporter });
      expect(read.code).toBe(0);
      const before = await names();
      const create = await orch(["folders", "create", "/reporter", ...project()], {
        token: tokens.reporter,
      });
      expect(create.code).toBe(1);
      expect(create.err[0]).toContain("forbidden");
      const rm = await orch(["folders", "rm", "/billing", ...project()], {
        token: tokens.reporter,
      });
      expect(rm.code).toBe(1);
      expect(await names()).toEqual(before);
    });

    test("a long tree is not listed whole when a path is unknown", async () => {
      for (let i = 1; i <= 11; i++) {
        const name = `many-${String(i).padStart(2, "0")}`;
        expect((await send("POST", `${base()}/folders`, { name })).status).toBe(201);
      }
      const res = await orch(["folders", "rm", "/nope", ...project()]);
      expect(res.code).toBe(2);
      expect(res.err[0]).toMatch(/^error: no folder '\/nope'; known: \/billing, .*, \.\.\.$/);
      expect(res.err[0]).not.toContain("/payments");
    });
  });
});
