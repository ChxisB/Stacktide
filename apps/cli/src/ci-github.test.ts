import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "@orch/api";
import { callerPrincipal } from "@orch/api/credentials";
import { makeKey, type Signer, sign } from "@orch/api/jwt-testing";
import { createLogger } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import { createConnection, createOrganization, importProject } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { ciCommands } from "./ci";
import { runCli } from "./cli";

/** FRG-23: in a GitHub Actions job `orch ci login` asks the runner for the identity token itself. */
const AUDIENCE = "orch.example.com";
const REPOSITORY = 5501;
const REQUEST_TOKEN = `SEKRIT-request-${Bun.randomUUIDv7()}`;
const keys = envKeyProvider(`k1:${Buffer.alloc(32, 7).toString("base64")}`);

let t: TestDb;
let signer: Signer;
let dir: string;
let api: string;
let runner: string; // the runner's token endpoint
const servers: { stop: (force: boolean) => unknown }[] = [];
const asked: { authorization: string | null; audience: string | null; kept: string | null }[] = [];
let answer: (audience: string) => Promise<unknown> = async () => ({});
let projectId = "";
let orgId = "";
/** Everything a test made that must never be printed. */
const credentials: string[] = [];
const quiet: string[] = [];

const seconds = () => Date.now() / 1000;
const mint = async (audience: string) => {
  const token = await sign(signer, {
    iss: "https://token.actions.githubusercontent.com",
    aud: audience,
    sub: "repo:acme/web:ref:refs/heads/main",
    iat: seconds() - 5,
    nbf: seconds() - 5,
    exp: seconds() + 300,
    repository_id: String(REPOSITORY),
    ref: "refs/heads/main",
    ref_protected: "true",
    event_name: "workflow_dispatch",
  });
  credentials.push(token, token.split(".")[1] as string);
  return token;
};

beforeAll(async () => {
  t = await createTestDb();
  signer = await makeKey("github");
  orgId = (await createOrganization(t.db, { slug: "acme", name: "Acme" })).id;
  const connection = await createConnection(t.db, keys, {
    organizationId: orgId,
    type: "github",
    name: "github",
    config: { baseUrl: "https://github.com" },
    token: "ghp_xxxxxxxx",
  });
  projectId = (
    await importProject(t.db, {
      organizationId: orgId,
      connectionId: connection.id,
      gitlabProjectId: REPOSITORY,
      name: "web",
      defaultBranch: "main",
      types: [],
    })
  ).project.id;
  const app = createApp({
    logger: createLogger({ level: "error", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({ db: t.db }),
    ready: async () => {},
    keys,
    ci: {
      key: async () => undefined,
      issuer: "https://gitlab.example.com",
      audience: AUDIENCE,
      github: async (kid) => (kid === signer.kid ? signer.jwk : undefined),
    },
  }).listen({ port: 0, hostname: "127.0.0.1" });
  servers.push(app);
  api = `http://127.0.0.1:${app.server?.port}`;

  const endpoint = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/redirect") {
        return new Response(null, { status: 302, headers: { location: "/token?api-version=2.0" } });
      }
      const audience = url.searchParams.get("audience");
      asked.push({
        authorization: req.headers.get("authorization"),
        audience,
        kept: url.searchParams.get("api-version"),
      });
      if (req.headers.get("authorization") !== `Bearer ${REQUEST_TOKEN}`) {
        return new Response("no", { status: 401 });
      }
      return Response.json(await answer(audience ?? ""));
    },
  });
  servers.push(endpoint);
  runner = `http://127.0.0.1:${endpoint.port}/token?api-version=2.0`;
  dir = await mkdtemp(join(tmpdir(), "orch-ci-github-"));
});
afterAll(async () => {
  for (const server of servers) await server.stop(true);
  await t.drop();
  await rm(dir, { recursive: true, force: true });
  for (const credential of credentials) expect(quiet.join("\n")).not.toContain(credential);
});

async function login(env: Record<string, string | undefined>, extra: string[] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(["ci", "login", ...extra], {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: { ORCH_CONFIG: join(dir, "no-config.json"), ORCH_API_URL: api, ...env },
    cwd: dir,
    home: dir,
    stdin: async () => "",
    open: async () => {},
    confirm: async () => false,
    version: "0.0.0",
    commands: ciCommands(),
  });
  quiet.push(...err);
  return { code, out, err };
}
const actions = (over: Record<string, string | undefined> = {}) => ({
  ACTIONS_ID_TOKEN_REQUEST_URL: runner,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: REQUEST_TOKEN,
  ORCH_AUDIENCE: AUDIENCE,
  ...over,
});
const reset = () => {
  asked.length = 0;
  answer = async (audience) => ({ value: await mint(audience) });
};

describe("orch ci login in a GitHub Actions job", () => {
  test("asks the runner for a token for the audience and signs the job in with it", async () => {
    reset();
    const { code, out, err } = await login(actions());
    expect(code).toBe(0);
    expect(asked).toEqual([
      { authorization: `Bearer ${REQUEST_TOKEN}`, audience: AUDIENCE, kept: "2.0" },
    ]);
    const text = out.join("\n");
    expect(text).toContain(`ORCH_PROJECT='${projectId}'`);
    expect(text).toContain(`ORCH_ORG='${orgId}'`);
    expect(text).toMatch(/ORCH_TOKEN='orchci_/);
    expect(err[0]).toMatch(/^signed in for this job until /);
    const token = /ORCH_TOKEN='([^']+)'/.exec(text)?.[1];
    if (token) credentials.push(token);
    // nothing of what was asked with leaves on stdout
    expect(text).not.toContain(REQUEST_TOKEN);
  });

  test("--audience wins over the environment", async () => {
    reset();
    await login(actions({ ORCH_AUDIENCE: "not-this-one" }), ["--audience", AUDIENCE]);
    expect(asked.map((a) => a.audience)).toEqual([AUDIENCE]);
  });

  test("a job given a token of its own does not ask the runner", async () => {
    reset();
    const { code } = await login(actions({ ORCH_ID_TOKEN: await mint(AUDIENCE) }));
    expect([code, asked]).toEqual([0, []]);
  });

  test("with no audience to ask for, it says so and asks nothing", async () => {
    reset();
    const { code, err } = await login(actions({ ORCH_AUDIENCE: undefined }));
    expect([code, asked]).toEqual([2, []]);
    expect(err.join("\n")).toContain("audience");
  });

  test("a runner address that is not https is not sent the job's request token", async () => {
    reset();
    for (const url of [
      "http://runner.example.com/token?x=1",
      "ftp://runner.example.com/t",
      "nope",
    ]) {
      const { code, err } = await login(actions({ ACTIONS_ID_TOKEN_REQUEST_URL: url }));
      expect([url, code]).toEqual([url, 2]);
      expect(err.join("\n")).not.toContain(REQUEST_TOKEN);
    }
    expect(asked).toEqual([]);
  });

  test("a job with no permission to ask (no request token) is told what to add", async () => {
    reset();
    const { code, err } = await login(actions({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: undefined }));
    expect([code, asked]).toEqual([2, []]);
    expect(err.join("\n")).toContain("id-token: write");
  });

  test("an answer that is no token, or no answer at all, fails without printing it", async () => {
    for (const body of [{ value: "not a token" }, { value: 5 }, {}, { oops: true }]) {
      reset();
      answer = async () => body;
      const { code, out, err } = await login(actions());
      expect([JSON.stringify(body), code === 0]).toEqual([JSON.stringify(body), false]);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain("did not answer with an identity token");
      expect(err.join("\n")).not.toContain("not a token");
    }
  });

  test("a redirect from the runner is not followed with the job's request token", async () => {
    reset();
    const { code, out } = await login(
      actions({ ACTIONS_ID_TOKEN_REQUEST_URL: runner.replace("/token", "/redirect") }),
    );
    expect([code === 0, out, asked]).toEqual([false, [], []]);
  });

  test("a runner that refuses is an error that names no token", async () => {
    reset();
    const { code, out, err } = await login(actions({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "wrong" }));
    expect([code === 0, out]).toEqual([false, []]);
    expect(err.join("\n")).not.toContain("wrong");
  });

  test("the platform refusing the token is said as for any other", async () => {
    reset();
    answer = async (audience) => ({ value: await mint(`${audience}-other`) });
    const { code, err } = await login(actions());
    expect(code === 0).toBe(false);
    expect(err.join("\n")).toContain("id_token was refused");
  });
});
