import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { makeKey, type Signer, sign } from "@orch/api/jwt-testing";
import { newApiToken } from "@orch/api/tokens";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createApiToken,
  createEnvironment,
  createOrganization,
  createProject,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { generatePipeline } from "@orch/iac";
import { ciCommands } from "./ci";
import { runCli } from "./cli";
import { varsCommands } from "./vars";

const ISSUER = "https://gitlab.example.com";
const AUDIENCE = "orch.example.com";
const GITLAB_PROJECT = 9101;
const keys = envKeyProvider(`k1:${Buffer.alloc(32, 9).toString("base64")}`);

let t: TestDb;
let signer: Signer;
let dir: string;
let api: string;
const servers: { stop: (force: boolean) => unknown }[] = [];
const ids = {} as Record<"org" | "web" | "dev" | "prod" | "other", string>;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();

const makeApp = (ci: boolean) =>
  createApp({
    logger: createLogger({ level: "error", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
    ci: ci
      ? {
          key: async (kid) => (signer.jwk.kid === kid ? signer.jwk : undefined),
          issuer: ISSUER,
          audience: AUDIENCE,
        }
      : undefined,
  });
const listen = (ci: boolean) => {
  const server = makeApp(ci).listen({ port: 0, hostname: "127.0.0.1" });
  servers.push(server);
  return `http://127.0.0.1:${server.server?.port}`;
};

const dbPassword = `SEKRIT-db-${Bun.randomUUIDv7()}`;
const orgSecret = `SEKRIT-org-${Bun.randomUUIDv7()}`;
/** Every token and id_token a test made: none may appear in anything printed where no token belongs. */
const credentials: string[] = [];
/** What the commands wrote to stderr, and to stdout where stdout is not the answer. */
const quiet: string[] = [];

beforeAll(async () => {
  t = await createTestDb();
  signer = await makeKey("k1");
  ids.org = (await createOrganization(t.db, { slug: "acme", name: "Acme" })).id;
  const project = async (name: string, gitlabProjectId: number) =>
    (await createProject(t.db, { organizationId: ids.org, name, gitlabProjectId })).id;
  ids.web = await project("web", GITLAB_PROJECT);
  const other = await project("other", GITLAB_PROJECT + 1);
  const env = async (projectId: string, slug: string) =>
    (await createEnvironment(t.db, { organizationId: ids.org, projectId, name: slug, slug })).id;
  ids.dev = await env(ids.web, "dev");
  ids.prod = await env(ids.web, "prod");
  ids.other = await env(other, "dev");

  const admin = await upsertUser(t.db, { gitlabId: 901, username: "admin", name: "admin" });
  roleTable.set(901, { orgRoles: { [ids.org]: "admin" }, projectRoles: {} });
  const fresh = newApiToken();
  await createApiToken(t.db, {
    userId: admin.id,
    name: "test",
    prefix: fresh.prefix,
    tokenHash: fresh.tokenHash,
    scopes: ["*"],
    ttlMs: 3_600_000,
  });

  api = listen(true);
  const set = async (path: string, key: string, kind: string, value: string) => {
    const res = await fetch(`${api}${path}/variables`, {
      method: "POST",
      headers: { authorization: `Bearer ${fresh.token}`, "content-type": "application/json" },
      body: JSON.stringify({ key, kind, value }),
    });
    expect(res.status).toBe(201);
  };
  const o = `/organizations/${ids.org}`;
  await set(o, "ORG_SECRET", "secret", orgSecret);
  await set(
    `${o}/projects/${ids.web}/environments/${ids.dev}`,
    "DB_PASSWORD",
    "secret",
    dbPassword,
  );
  await set(`${o}/projects/${ids.web}/environments/${ids.prod}`, "PROD_ONLY", "plain", "yes");
  dir = await mkdtemp(join(tmpdir(), "orch-ci-"));
});
afterAll(async () => {
  for (const server of servers) await server.stop(true);
  await t.drop();
  await rm(dir, { recursive: true, force: true });
  for (const credential of credentials) expect(quiet.join("\n")).not.toContain(credential);
});

const seconds = () => Date.now() / 1000;
const idToken = (over: Record<string, unknown> = {}) => {
  const issued = sign(signer, {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: "project_path:acme/web:ref_type:branch:ref:main",
    iat: seconds() - 5,
    nbf: seconds() - 5,
    exp: seconds() + 300,
    project_id: String(GITLAB_PROJECT),
    job_id: "1",
    ref: "main",
    ref_type: "branch",
    ref_protected: "true",
    environment: "dev",
    environment_protected: "false",
    ...over,
  });
  return issued.then((token) => {
    credentials.push(token, token.split(".")[1] as string);
    return token;
  });
};

interface Run {
  env?: Record<string, string | undefined>;
  url?: string;
  commands?: Parameters<typeof runCli>[1]["commands"];
  /** Output the test reads on purpose (a token, or exported values). */
  prints?: boolean;
}
async function orch(argv: string[], run: Run = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: { ORCH_CONFIG: join(dir, "no-config.json"), ORCH_API_URL: run.url ?? api, ...run.env },
    cwd: dir,
    home: dir,
    stdin: async () => "",
    open: async () => {},
    confirm: async () => false,
    version: "0.0.0",
    commands: run.commands ?? { ...ciCommands(), ...varsCommands() },
  });
  quiet.push(...err, ...(run.prints ? [] : out));
  return { code, out, err };
}
const login = async (over: Record<string, unknown> = {}, extra: string[] = []) =>
  orch(["ci", "login", ...extra], {
    env: { ORCH_ID_TOKEN: await idToken(over) },
    prints: true,
  });

/** What a shell has set after `eval`ing `script`, as the job's later steps see it. */
async function evalled(script: string) {
  const proc = Bun.spawn(
    [
      "sh",
      "-c",
      `eval "$1"; printf '%s\\n' "$ORCH_API_URL" "$ORCH_ORG" "$ORCH_PROJECT" "$ORCH_ENV" "$ORCH_TOKEN"`,
      "sh",
      script,
    ],
    { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
  );
  const [text, code] = [await new Response(proc.stdout).text(), await proc.exited];
  expect(code).toBe(0);
  const [apiUrl, org, project, env, token] = text.split("\n");
  if (token) credentials.push(token);
  return { apiUrl, org, project, env, token };
}

describe("orch ci login", () => {
  test("prints what `eval` needs to sign the job in, and nothing is written to disk", async () => {
    const before = await readdir(dir);
    const { code, out, err } = await login();
    expect(code).toBe(0);
    expect(err).toEqual([expect.stringMatching(/^signed in for this job until \d{4}-/)]);
    const set = await evalled(out.join("\n"));
    expect(set).toMatchObject({
      apiUrl: api,
      org: ids.org,
      project: ids.web,
      env: ids.dev,
      token: expect.stringMatching(/^orchci_/),
    });
    expect(await readdir(dir)).toEqual(before);
  });

  test("the job it signs in reads and runs with its environment's values, with no flags or files", async () => {
    const { out } = await login();
    const job = await evalled(out.join("\n"));
    const env = {
      ORCH_API_URL: job.apiUrl,
      ORCH_ORG: job.org,
      ORCH_PROJECT: job.project,
      ORCH_ENV: job.env,
      ORCH_TOKEN: job.token,
    };
    const exported = await orch(["export", "--format", "json"], { env, prints: true });
    expect(exported.code).toBe(0);
    expect(JSON.parse(exported.out.join("\n"))).toEqual({
      DB_PASSWORD: dbPassword,
      ORG_SECRET: orgSecret,
    });
    expect((await orch(["run", "--", "true"], { env })).code).toBe(0);
    expect((await orch(["run", "--", "false"], { env })).code).toBe(1);
  });

  test("the token reaches its own environment and no other, in this or another project", async () => {
    const { out } = await login();
    const job = await evalled(out.join("\n"));
    const env = { ORCH_API_URL: api, ORCH_TOKEN: job.token, ORCH_ORG: ids.org };
    for (const [project, environment] of [
      [ids.web, ids.prod],
      [ids.web, ids.other],
    ] as const) {
      const res = await orch(["export", "--project", project, "--env", environment], { env });
      expect([project, environment, res.code]).toEqual([project, environment, 1]);
    }
    const mine = await orch(["export", "--project", ids.web, "--env", ids.dev], {
      env,
      prints: true,
    });
    expect(mine.code).toBe(0);
  });

  test("a protected environment is signed in from a protected ref", async () => {
    const protectedJob = { environment: "prod", environment_protected: "true" };
    const { code, out } = await login(protectedJob);
    expect(code).toBe(0);
    expect((await evalled(out.join("\n"))).env).toBe(ids.prod);
    const loose = await login({ ...protectedJob, ref_protected: "false" });
    expect(loose.code).toBe(1);
    expect(loose.err.join("\n")).toContain("ref_not_protected");
    expect(loose.out).toEqual([]);
  });

  test("--json is one document, with the token it exists to give", async () => {
    const { code, out } = await orch(["--json", "ci", "login"], {
      env: { ORCH_ID_TOKEN: await idToken() },
      prints: true,
    });
    expect(code).toBe(0);
    const doc = JSON.parse(out.join("\n"));
    credentials.push(doc.token);
    expect(doc).toEqual({
      apiUrl: api,
      token: expect.stringMatching(/^orchci_/),
      expiresAt: expect.any(String),
      scopes: ["project.read", "environment.read", "secret.reveal"],
      organizationId: ids.org,
      projectId: ids.web,
      environmentId: ids.dev,
    });
  });

  test("a job in no environment gets a project token and is told so", async () => {
    const { code, out, err } = await login({
      environment: undefined,
      environment_protected: undefined,
    });
    expect(code).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("ORCH_ENV");
    expect(err.join("\n")).toContain("environment: name:");
    await evalled(text);
  });

  test("a newline after the id_token, as a variable often has, is not part of it", async () => {
    const res = await orch(["ci", "login"], {
      env: { ORCH_ID_TOKEN: `${await idToken()}\n` },
      prints: true,
    });
    expect(res.code).toBe(0);
    await evalled(res.out.join("\n"));
  });

  test("the id_token can come from another variable", async () => {
    const token = await idToken();
    const named = await orch(["ci", "login", "--id-token-env", "GITLAB_JWT"], {
      env: { GITLAB_JWT: token },
      prints: true,
    });
    expect(named.code).toBe(0);
    // the default one is then not looked at
    const unset = await orch(["ci", "login", "--id-token-env", "GITLAB_JWT"], {
      env: { ORCH_ID_TOKEN: token },
    });
    expect(unset.code).toBe(2);
    await evalled(named.out.join("\n"));
  });
});

describe("what is refused", () => {
  test("an id_token for another audience: it fails, says why, and prints no token", async () => {
    const token = await idToken({ aud: "somewhere.else" });
    const { code, out, err } = await orch(["ci", "login"], { env: { ORCH_ID_TOKEN: token } });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    const text = err.join("\n");
    expect(text).toContain("the id_token was refused");
    expect(text).toContain("aud");
    expect(text).not.toContain("orch login"); // a job has no login to run
    expect(text).not.toContain(token);
  });

  test("a token from the wrong issuer, or an expired one, is refused the same way", async () => {
    for (const over of [{ iss: "https://evil.example.com" }, { exp: seconds() - 3600 }]) {
      const res = await orch(["ci", "login"], { env: { ORCH_ID_TOKEN: await idToken(over) } });
      expect([res.code, res.err.join("\n")]).toEqual([1, expect.stringContaining("was refused")]);
    }
  });

  test("a project that is not registered says so", async () => {
    const res = await orch(["ci", "login"], {
      env: { ORCH_ID_TOKEN: await idToken({ project_id: "424242" }) },
    });
    expect(res.code).toBe(1);
    expect(res.err.join("\n")).toContain("project_not_registered");
  });

  test("an API with no CI audience set says it is off", async () => {
    const res = await orch(["ci", "login"], {
      env: { ORCH_ID_TOKEN: await idToken() },
      url: listen(false),
    });
    expect(res.code).toBe(1);
    expect(res.err.join("\n")).toContain("ci_unavailable");
  });

  test("without an id_token in the environment it asks for the id_tokens entry, as a usage error", async () => {
    for (const env of [{}, { ORCH_ID_TOKEN: "" }, { ORCH_ID_TOKEN: "  \n" }]) {
      const res = await orch(["ci", "login"], { env });
      expect(res.code).toBe(2);
      expect(res.err.join("\n")).toContain("id_tokens:");
    }
  });

  test("something that is not an id_token is not sent anywhere, and not repeated", async () => {
    const sekrit = `hunter2-${Bun.randomUUIDv7()}`;
    credentials.push(sekrit);
    for (const value of [sekrit, `a.b.${sekrit}!`, "a.b", `${"a".repeat(8200)}.b.c`]) {
      // an address nothing answers on: reaching it would be "cannot reach", not a usage error
      const res = await orch(["ci", "login"], {
        env: { ORCH_ID_TOKEN: value },
        url: "http://127.0.0.1:1",
      });
      expect([value.length > 100 ? "long" : value, res.code]).toEqual([
        value.length > 100 ? "long" : value,
        2,
      ]);
      expect(res.err.join("\n")).toBe("error: ORCH_ID_TOKEN does not hold an id_token");
    }
  });

  test("the exchange carries no credential, whatever ORCH_TOKEN holds", async () => {
    const seen: (string | null)[] = [];
    const relay = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        seen.push(request.headers.get("authorization"));
        return fetch(`${api}${new URL(request.url).pathname}`, request);
      },
    });
    servers.push(relay);
    const res = await orch(["ci", "login"], {
      env: { ORCH_ID_TOKEN: await idToken(), ORCH_TOKEN: "orch_AAAAAAAA.stale" },
      url: `http://127.0.0.1:${relay.port}`,
      prints: true,
    });
    expect(res.code).toBe(0);
    expect(seen).toEqual([null]);
    const set = await evalled(res.out.join("\n"));
    expect(set.token).toMatch(/^orchci_/);
  });

  test("an answer that is not the API's is not trusted, and nothing is printed", async () => {
    const junk = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ token: "", scopes: "all" }, { status: 201 }),
    });
    servers.push(junk);
    const res = await orch(["ci", "login"], {
      env: { ORCH_ID_TOKEN: await idToken() },
      url: `http://127.0.0.1:${junk.port}`,
    });
    expect(res.code).toBe(1);
    expect(res.out).toEqual([]);
    expect(res.err.join("\n")).toContain("does not look like an orch API");
  });

  test("usage mistakes: an unknown subcommand, extra words, a bad variable name, an API that is not https", async () => {
    const env = { ORCH_ID_TOKEN: await idToken() };
    for (const name of ["A B", "X;touch /tmp/owned", "1X", ""]) {
      const res = await orch(["ci", "login", "--id-token-env", name], { env });
      expect([name, res.code, res.err.join("\n")]).toEqual([
        name,
        2,
        "error: --id-token-env must be the name of an environment variable",
      ]);
    }
    for (const argv of [
      ["ci"],
      ["ci", "logout"],
      ["ci", "login", "extra"],
      ["ci", "login", "--id-token-env", "A B"],
      ["ci", "login", "--id-token-env", "X;touch /tmp/owned"],
      ["ci", "login", "--api-url", "http://orch.example.com"],
      ["ci", "login", "--nope"],
    ]) {
      const res = await orch(argv, { env });
      expect([argv, res.code]).toEqual([argv, 2]);
    }
  });

  test("an API URL is needed, from the flag or ORCH_API_URL", async () => {
    const res = await orch(["ci", "login"], {
      env: { ORCH_ID_TOKEN: await idToken(), ORCH_API_URL: "" },
    });
    expect(res.code).toBe(2);
    expect(res.err.join("\n")).toContain("no API URL");
  });
});

// IAC-11: the plan job the platform generates for a stack with an `environment`, run the way the
// runner runs it: its script lines, in order, stopping at the first that fails, with the real `orch`
// against the real API, signed in by an id_token, and a `terraform` that only records what it was given.
describe("a generated plan job of a stack with an environment", () => {
  const main = join(import.meta.dir, "main.ts");

  /** The job's script and variables for a stack in `environment`, from the generator. */
  const generated = (environment: string) => {
    const yaml = generatePipeline({
      action: "plan",
      stacks: [
        {
          name: "app",
          path: "stacks/app",
          tool: "terraform",
          version: "1.9.8",
          tags: [],
          dependsOn: [],
          watch: [],
          applyOn: "command",
          environment,
          backend: "http",
        },
      ],
      select: ["app"],
      audience: AUDIENCE,
      apiUrl: api,
      summaryPath: "/runs/0b9e5bd2/plan-summary",
      helperImage: "registry.example.com/orch/helper:1",
      images: { terraform: "registry.example.com/platform/terraform-orch" },
    });
    const job = (Bun.YAML.parse(yaml) as Record<string, { script: string[] }>)["plan:app"];
    if (!job) throw new Error("no plan job");
    return { yaml, script: job.script };
  };

  /** Runs the job script in a fresh directory where `orch` is this repository's and `terraform` a recorder. */
  async function runJob(environment: string, claims: Record<string, unknown> = {}) {
    const { yaml, script } = generated(environment);
    const work = await mkdtemp(join(dir, "job-"));
    const bin = join(work, "bin");
    const seen = join(work, "seen");
    await mkdir(bin);
    await mkdir(seen);
    await mkdir(join(work, "stacks", "app"), { recursive: true });
    const tool = async (name: string, body: string) => {
      await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
      await chmod(join(bin, name), 0o755);
    };
    await tool("orch", `exec "${process.execPath}" "${main}" "$@"`);
    await tool(
      "terraform",
      [
        'env > "$SEEN/$1.env"',
        'case "$1" in',
        "  plan) : > plan.tfplan ;;",
        `  show) echo '{"resource_changes":[]}' ;;`,
        "esac",
      ].join("\n"),
    );
    const proc = Bun.spawn(["sh", "-ec", script.join("\n")], {
      cwd: work,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: work,
        ORCH_CONFIG: join(work, "no-config.json"),
        ORCH_API_URL: api,
        ORCH_ID_TOKEN: await idToken({ environment, ...claims }),
        SEEN: seen,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = [
      await new Response(proc.stdout).text(),
      await new Response(proc.stderr).text(),
      await proc.exited,
    ];
    // the job's own output is quiet: no token, no value
    quiet.push(out, err);
    const run = async (command: string) => {
      const file = Bun.file(join(seen, `${command}.env`));
      if (!(await file.exists())) return undefined;
      return Object.fromEntries(
        (await file.text())
          .split("\n")
          .filter((line) => line.includes("="))
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
    };
    return { yaml, code, out, err, work, run };
  }

  test("every tool command gets the environment's variables as TF_VAR_*, and nothing else of orch's", async () => {
    const job = await runJob("dev");
    expect(job.code).toBe(0);
    expect(job.out).toBe("");
    // the pipeline never held a value: they were fetched when the job ran
    expect(job.yaml).not.toContain(dbPassword);
    expect(job.yaml).not.toContain(orgSecret);
    for (const command of ["init", "plan", "show"]) {
      const env = await job.run(command);
      expect(env, command).toBeDefined();
      expect(env).toMatchObject({ TF_VAR_DB_PASSWORD: dbPassword, TF_VAR_ORG_SECRET: orgSecret });
      // under no name but the prefixed one, and without the keys orch signs in with
      for (const name of ["DB_PASSWORD", "ORG_SECRET", "ORCH_TOKEN", "ORCH_ID_TOKEN"]) {
        expect(env, `${command} ${name}`).not.toHaveProperty(name);
      }
      expect(
        Object.keys(env ?? {})
          .filter((k) => k.startsWith("TF_VAR_"))
          .sort(),
      ).toEqual(["TF_VAR_DB_PASSWORD", "TF_VAR_ORG_SECRET"]);
    }
    // what the tool wrote to stdout is the plan JSON, untouched by anything orch said
    expect(await readFile(join(job.work, "stacks/app/plan.json"), "utf8")).toBe(
      '{"resource_changes":[]}\n',
    );
    expect(await Bun.file(join(job.work, "stacks/app/plan.tfplan")).exists()).toBe(true);
  }, 60_000);

  test("a job that cannot sign in stops before the tool runs: an environment the project lacks, an unprotected ref on a protected one", async () => {
    for (const [environment, claims, why] of [
      ["staging", {}, "environment_not_found"],
      ["prod", { environment_protected: "true", ref_protected: "false" }, "ref_not_protected"],
    ] as const) {
      const job = await runJob(environment, claims);
      expect([environment, job.code === 0]).toEqual([environment, false]);
      expect(job.err).toContain(why);
      for (const command of ["init", "plan", "show"])
        expect(await job.run(command)).toBeUndefined();
      expect(await Bun.file(join(job.work, "stacks/app/plan.json")).exists()).toBe(false);
    }
  }, 60_000);
});
