import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, loadConfig } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  importProject,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab } from "@orch/gitlab/mock";
import { createApp } from "./app";
import { authEnv, ciFromEnv } from "./auth-config";
import { callerPrincipal } from "./credentials";
import { makeKey, type Signer, sign } from "./jwt-testing";

/**
 * FRG-5: a CI token is checked against the instance that issued it, and only reaches a project that
 * instance owns. Two real (mock) GitLabs with different addresses both have a project 42.
 */
const AUDIENCE = "orch.example.com";
const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let A: ReturnType<typeof createMockGitlab>; // the deployment's own GitLab (GITLAB_URL)
let B: ReturnType<typeof createMockGitlab>; // a second instance, known by a connection
let C: ReturnType<typeof createMockGitlab>; // an instance nobody registered
let sa: Signer;
let sb: Signer;
let sc: Signer;
let app: ReturnType<typeof makeApp>;
const lines: string[] = [];
const ids = {} as Record<"pa" | "pb" | "pa43" | "legacy" | "stagingB", string>;

const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
const makeApp = () =>
  createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({ db: t.db }),
    ready: async () => {},
    ci: ciFromEnv(
      loadConfig(authEnv, {
        GITLAB_URL: A.url,
        GITLAB_OAUTH_CLIENT_ID: "app-id",
        GITLAB_OAUTH_CLIENT_SECRET: "app-secret",
        GITLAB_OAUTH_REDIRECT_URI: "https://orch.example.com/auth/callback",
        ORCH_CI_AUDIENCE: AUDIENCE,
      }),
      t.db,
    ),
  });

const connect = (organizationId: string, baseUrl: string) =>
  createConnection(t.db, keys, {
    organizationId,
    type: "gitlab",
    name: "gl",
    config: { baseUrl },
    token: "glpat-x",
  });
const bind = (
  organizationId: string,
  connectionId: string,
  gitlabProjectId: number,
  name: string,
) =>
  importProject(t.db, {
    organizationId,
    connectionId,
    gitlabProjectId,
    name,
    defaultBranch: "main",
    types: [],
  });

beforeAll(async () => {
  t = await createTestDb();
  [A, B, C] = [createMockGitlab(), createMockGitlab(), createMockGitlab()];
  [sa, sb, sc] = [await makeKey("ka"), await makeKey("kb"), await makeKey("kc")];
  A.setJwks([sa.jwk]);
  B.setJwks([sb.jwk]);
  C.setJwks([sc.jwk]);
  const [o1, o2, o3] = [
    await createOrganization(t.db, { slug: "one", name: "One" }),
    await createOrganization(t.db, { slug: "two", name: "Two" }),
    await createOrganization(t.db, { slug: "three", name: "Three" }),
  ];
  const [ca, cb] = [await connect(o1.id, A.url), await connect(o2.id, `${B.url}/`)];
  const [pa, pb, pa43] = [
    await bind(o1.id, ca.id, 42, "a-web"),
    await bind(o2.id, cb.id, 42, "b-web"),
    await bind(o1.id, ca.id, 43, "a-only"),
  ];
  const legacy = await createProject(t.db, {
    organizationId: o3.id,
    name: "legacy",
    gitlabProjectId: 44,
  });
  const stagingB = await createEnvironment(t.db, {
    organizationId: o2.id,
    projectId: pb.project.id,
    name: "staging",
    slug: "staging",
  });
  Object.assign(ids, {
    pa: pa.project.id,
    pb: pb.project.id,
    pa43: pa43.project.id,
    legacy: legacy.id,
    stagingB: stagingB.id,
  });
  app = makeApp();
});
afterAll(async () => {
  for (const m of [A, B, C]) m.stop();
  await t.drop();
});

const seconds = () => Date.now() / 1000;
const claims = (iss: string, over: Record<string, unknown> = {}) => ({
  iss,
  aud: AUDIENCE,
  sub: "project_path:acme/web:ref_type:branch:ref:main",
  iat: seconds() - 5,
  nbf: seconds() - 5,
  exp: seconds() + 300,
  project_id: "42",
  job_id: "777",
  ref: "main",
  ref_protected: "true",
  ...over,
});
const exchange = async (id_token: string) => {
  const res = await app.handle(
    new Request("http://localhost/auth/ci/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token }),
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
};
const keyFetches = (m: ReturnType<typeof createMockGitlab>) =>
  m.requests.filter((r) => r.path === "/oauth/discovery/keys").length;

describe("a token of the instance that issued it", () => {
  test("project 42 of each instance is its own project", async () => {
    const a = await exchange(await sign(sa, claims(A.url)));
    expect([a.status, a.json.projectId]).toEqual([201, ids.pa]);
    const b = await exchange(await sign(sb, claims(B.url)));
    expect([b.status, b.json.projectId]).toEqual([201, ids.pb]);
  });

  test("an environment of the second instance's project is reached by its token", async () => {
    const b = await exchange(
      await sign(sb, claims(B.url, { environment: "staging", environment_protected: "false" })),
    );
    expect([b.status, b.json.environmentId]).toEqual([201, ids.stagingB]);
  });

  test("the second instance's keys are fetched once for several tokens", async () => {
    await exchange(await sign(sb, claims(B.url)));
    await exchange(await sign(sb, claims(B.url)));
    expect(keyFetches(B)).toBe(1);
  });
});

describe("a token that is not that instance's", () => {
  test("one instance's token for a project only the other has is refused", async () => {
    const res = await exchange(await sign(sb, claims(B.url, { project_id: "43" })));
    expect([res.status, res.json.code]).toEqual([403, "project_not_registered"]);
    // and the other way round: A's own token for A's project 43 is fine
    expect(
      (await exchange(await sign(sa, claims(A.url, { project_id: "43" })))).json.projectId,
    ).toBe(ids.pa43);
  });

  test("a project linked before connections belongs to the deployment's GitLab alone", async () => {
    const ok = await exchange(await sign(sa, claims(A.url, { project_id: "44" })));
    expect([ok.status, ok.json.projectId]).toEqual([201, ids.legacy]);
    const other = await exchange(await sign(sb, claims(B.url, { project_id: "44" })));
    expect([other.status, other.json.code]).toEqual([403, "project_not_registered"]);
  });

  test("a token signed by the other instance's keys is refused, whatever issuer it names", async () => {
    for (const [by, iss] of [
      [sa, B.url],
      [sb, A.url],
    ] as const) {
      const res = await exchange(await sign(by, claims(iss)));
      expect([res.status, res.json.code]).toEqual([401, "invalid_id_token"]);
    }
  });

  test("an instance no connection registered is refused, and never called", async () => {
    const res = await exchange(await sign(sc, claims(C.url)));
    expect([res.status, res.json.code]).toEqual([401, "invalid_id_token"]);
    expect(C.requests).toEqual([]);
  });

  test("an address that only looks like a registered one is not one", async () => {
    for (const iss of [`${B.url}/x`, B.url.replace("http", "HTTP"), `${B.url}%`, `${B.url}/..`]) {
      const res = await exchange(await sign(sb, claims(iss)));
      expect([iss, res.status]).toEqual([iss, 401]);
    }
  });

  test("the wrong audience is refused for any instance", async () => {
    for (const [by, iss] of [
      [sa, A.url],
      [sb, B.url],
    ] as const) {
      const res = await exchange(await sign(by, claims(iss, { aud: "someone-else" })));
      expect([res.status, res.json.code]).toEqual([401, "invalid_id_token"]);
    }
  });

  test("an expired token is refused", async () => {
    const res = await exchange(await sign(sb, claims(B.url, { exp: seconds() - 3600 })));
    expect(res.status).toBe(401);
  });

  test("a refusal says nothing of the token, and the log has none of it", async () => {
    const token = await sign(sc, claims(C.url));
    const res = await exchange(token);
    expect(res.text).not.toContain(token);
    expect(lines.some((l) => l.includes(token))).toBe(false);
    expect(lines.some((l) => l.includes(token.split(".")[2] ?? "never"))).toBe(false);
  });
});

describe("an instance that cannot be reached", () => {
  test("is a 502 for its own tokens and does not touch the others", async () => {
    const d = createMockGitlab();
    const dKey = await makeKey("kd");
    const o = await createOrganization(t.db, { slug: "four", name: "Four" });
    const cd = await connect(o.id, d.url);
    await bind(o.id, cd.id, 42, "d-web");
    d.stop();
    const res = await exchange(await sign(dKey, claims(d.url)));
    expect([res.status, res.json.code]).toEqual([502, "gitlab_unavailable"]);
    expect((await exchange(await sign(sa, claims(A.url)))).status).toBe(201);
  });
});
