import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, loadConfig } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  ciTokens,
  createConnection,
  createEnvironment,
  createOrganization,
  importProject,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { GITHUB_OIDC_ISSUER } from "@orch/github";
import { GitlabError } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { eq } from "drizzle-orm";
import { createApp } from "./app";
import { authEnv, ciFromEnv } from "./auth-config";
import { callerPrincipal } from "./credentials";
import { makeKey, type Signer, sign } from "./jwt-testing";
import { hashToken } from "./tokens";

/**
 * FRG-23: a GitHub Actions identity token is checked against GitHub's keys and reaches only the project linked to
 * its repository through a github.com connection. There is no job id and no environment protection in it, and
 * `ref_protected` is trusted only when it is there, on a run of the repository's own branch.
 */
const AUDIENCE = "orch.example.com";
const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let gitlab: ReturnType<typeof createMockGitlab>;
let hub: Signer; // GitHub's signing key
let other: Signer; // anyone else's
let up = true;
let app: ReturnType<typeof makeApp>;
const lines: string[] = [];
const ids = {} as Record<
  "web" | "ghes" | "gitlab" | "shared1" | "prod" | "viaApi" | "trick",
  string
>;

const logger = createLogger({ level: "debug", write: (l) => lines.push(l) });
const makeApp = () => {
  const base = ciFromEnv(
    loadConfig(authEnv, {
      GITLAB_URL: gitlab.url,
      GITLAB_OAUTH_CLIENT_ID: "app-id",
      GITLAB_OAUTH_CLIENT_SECRET: "app-secret",
      GITLAB_OAUTH_REDIRECT_URI: "https://orch.example.com/auth/callback",
      ORCH_CI_AUDIENCE: AUDIENCE,
    }),
    t.db,
  );
  if (!base) throw new Error("the exchange is not configured");
  return createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({ db: t.db }),
    ready: async () => {},
    // GitHub's keys are not fetched in a test
    ci: {
      ...base,
      github: async (kid) => {
        if (!up) throw new GitlabError("network", "GitHub GET /.well-known/jwks request failed");
        return kid === hub.kid ? hub.jwk : undefined;
      },
    },
  });
};

const connect = (
  organizationId: string,
  type: "github" | "gitlab",
  baseUrl: string,
  name: string,
) =>
  createConnection(t.db, keys, {
    organizationId,
    type,
    name,
    config: { baseUrl },
    token: "ghp_xxxxxxxx",
  });
const bind = (organizationId: string, connectionId: string, id: number, name: string) =>
  importProject(t.db, {
    organizationId,
    connectionId,
    gitlabProjectId: id,
    name,
    defaultBranch: "main",
    types: [],
  });

beforeAll(async () => {
  t = await createTestDb();
  gitlab = createMockGitlab();
  [hub, other] = [await makeKey("github"), await makeKey("else")];
  const [o1, o2] = [
    await createOrganization(t.db, { slug: "one", name: "One" }),
    await createOrganization(t.db, { slug: "two", name: "Two" }),
  ];
  const [dotcom, ghes, gl, dotcom2, api] = [
    await connect(o1.id, "github", "https://github.com", "dotcom"),
    await connect(o1.id, "github", "https://ghe.example.com", "ghes"),
    await connect(o1.id, "gitlab", gitlab.url, "gitlab"),
    await connect(o2.id, "github", "https://github.com", "dotcom"),
    await connect(o2.id, "github", "https://api.github.com", "api"),
  ];
  const web = await bind(o1.id, dotcom.id, 1001, "web");
  const enterprise = await bind(o1.id, ghes.id, 2002, "ghes-web");
  const lab = await bind(o1.id, gl.id, 3003, "gitlab-web");
  const viaApi = await bind(o2.id, api.id, 6006, "via-api");
  // a GitLab connection whose address someone typed as github.com's must not make its projects repositories
  const trick = await bind(
    o1.id,
    (await connect(o1.id, "gitlab", "https://github.com", "trick")).id,
    7007,
    "trick",
  );
  const shared1 = await bind(o1.id, dotcom.id, 4004, "shared");
  await bind(o2.id, dotcom2.id, 4004, "shared-too");
  const prod = await createEnvironment(t.db, {
    organizationId: o1.id,
    projectId: web.project.id,
    name: "prod",
    slug: "prod",
  });
  Object.assign(ids, {
    web: web.project.id,
    ghes: enterprise.project.id,
    gitlab: lab.project.id,
    shared1: shared1.project.id,
    viaApi: viaApi.project.id,
    trick: trick.project.id,
    prod: prod.id,
  });
  app = makeApp();
});
afterAll(async () => {
  gitlab.stop();
  await t.drop();
});

const seconds = () => Date.now() / 1000;
const claims = (over: Record<string, unknown> = {}) => ({
  iss: GITHUB_OIDC_ISSUER,
  aud: AUDIENCE,
  sub: "repo:acme/web:ref:refs/heads/main",
  iat: seconds() - 5,
  nbf: seconds() - 5,
  exp: seconds() + 300,
  repository: "acme/web",
  repository_id: "1001",
  ref: "refs/heads/main",
  ref_protected: "true",
  event_name: "workflow_dispatch",
  run_id: "5551",
  ...over,
});
const without = (c: Record<string, unknown>, ...names: string[]) => {
  const copy = { ...c };
  for (const n of names) delete copy[n];
  return copy;
};
const exchange = async (id_token: string, state?: boolean) => {
  const res = await app.handle(
    new Request("http://localhost/auth/ci/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id_token, ...(state && { state }) }),
    }),
  );
  const text = await res.text();
  // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
};
const asHub = async (over: Record<string, unknown> = {}) => exchange(await sign(hub, claims(over)));

describe("a token of the repository linked to a project", () => {
  test("a protected-branch run reads the project, posts its summaries and takes leases", async () => {
    const res = await asHub();
    expect([res.status, res.json.projectId]).toEqual([201, ids.web]);
    // the run id is the job's identity: GitHub sends no job id
    expect(res.json.scopes).toEqual(["project.read", "run.summary", "lease.issue", "lease.revoke"]);
  });

  test("a token with no run id has no identity to count leases or lock state against", async () => {
    const res = await exchange(await sign(hub, without(claims(), "run_id")));
    expect([res.status, res.json.scopes]).toEqual([201, ["project.read", "run.summary"]]);
    const state = await exchange(await sign(hub, without(claims(), "run_id")), true);
    expect([state.status, state.json.scopes]).toEqual([201, ["project.read", "state.read"]]);
  });

  test("a run id that is not a number is not a token of GitHub's", async () => {
    for (const run_id of ["abc", "0", "-1", "1e3", "12345678901234567"]) {
      const res = await asHub({ run_id });
      expect([run_id, res.status, res.json.code]).toEqual([run_id, 401, "invalid_id_token"]);
    }
  });

  test("keeps the run and the branch's name as the platform writes it", async () => {
    const rows = async (over: Record<string, unknown>) => {
      const res = await asHub({ ...over, ref_protected: "false" });
      expect(res.status).toBe(201);
      const [row] = await t.db
        .select()
        .from(ciTokens)
        .where(eq(ciTokens.tokenHash, hashToken(res.json.token)));
      return row;
    };
    expect(await rows({ ref: "refs/heads/feature/net", run_id: "777" })).toMatchObject({
      ref: "feature/net",
      gitlabPipelineId: 777,
      gitlabJobId: null,
    });
    // a tag or a pull request's merge ref is not a branch of that name
    expect((await rows({ ref: "refs/tags/v1" }))?.ref).toBe("refs/tags/v1");
    expect((await rows({ ref: "refs/pull/3/merge" }))?.ref).toBe("refs/pull/3/merge");
  });

  test("a job in a registered environment, from a protected branch run by hand, reveals its values", async () => {
    const res = await asHub({ environment: "prod" });
    expect([res.status, res.json.environmentId]).toEqual([201, ids.prod]);
    expect(res.json.scopes).toContain("secret.reveal");
  });

  test("a connection made with GitHub's API address is github.com too", async () => {
    const res = await asHub({ repository_id: "6006" });
    expect([res.status, res.json.projectId]).toEqual([201, ids.viaApi]);
  });

  test("a state token writes the state only from a protected branch, locking it as the run", async () => {
    const res = await exchange(await sign(hub, claims()), true);
    expect([res.status, res.json.scopes]).toEqual([
      201,
      ["project.read", "state.read", "state.write"],
    ]);
    const open = await exchange(await sign(hub, claims({ ref_protected: "false" })), true);
    expect([open.status, open.json.scopes]).toEqual([201, ["project.read", "state.read"]]);
  });

  test("a run of a branch that is not protected reads the project only, even in an environment", async () => {
    const plain = await asHub({ ref_protected: "false" });
    expect([plain.status, plain.json.scopes]).toEqual([201, ["project.read", "run.summary"]]);
    // a run on a branch anyone can push to has an identity and still no lease
    const env = await asHub({ ref_protected: "false", environment: "prod" });
    expect([env.status, env.json.code]).toEqual([403, "ref_not_protected"]);
  });

  test("a token that does not say whether the branch is protected is not trusted", async () => {
    const res = await exchange(
      await sign(hub, without(claims({ environment: "prod" }), "ref_protected")),
    );
    expect([res.status, res.json.code]).toEqual([403, "ref_not_protected"]);
  });

  test("a run started by anything but the repository's own pushes and dispatches is not trusted", async () => {
    for (const event_name of [
      "pull_request",
      "pull_request_target",
      "workflow_run",
      "issues",
      "",
    ]) {
      const res = await asHub({ environment: "prod", event_name });
      expect([event_name, res.status, res.json.code]).toEqual([
        event_name,
        403,
        "ref_not_protected",
      ]);
    }
    const none = await exchange(
      await sign(hub, without(claims({ environment: "prod" }), "event_name")),
    );
    expect([none.status, none.json.code]).toEqual([403, "ref_not_protected"]);
    for (const event_name of ["push", "workflow_dispatch", "schedule", "release"]) {
      expect((await asHub({ environment: "prod", event_name })).status).toBe(201);
    }
  });

  test("an environment the project does not have is refused", async () => {
    const res = await asHub({ environment: "nowhere" });
    expect([res.status, res.json.code]).toEqual([403, "environment_not_found"]);
  });

  test("is recorded in the audit log as GitHub's, with the repository and no token", async () => {
    const token = await sign(hub, claims({ run_id: "123456" }));
    const res = await exchange(token);
    expect(res.status).toBe(201);
    const rows = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "auth.ci_exchange"));
    const last = rows.at(-1);
    expect(last?.metadata).toMatchObject({
      forge: "github",
      gitlabProjectId: 1001,
      gitlabPipelineId: 123456,
      ref: "main",
      refProtected: true,
    });
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(res.json.token);
  });
});

describe("a token of a repository that is not that project's", () => {
  test("another repository, a fork among them, is not registered", async () => {
    for (const repository_id of ["1002", "9999999"]) {
      const res = await asHub({ repository_id, repository: "someone/fork" });
      expect([repository_id, res.status, res.json.code]).toEqual([
        repository_id,
        403,
        "project_not_registered",
      ]);
    }
  });

  test("a GitLab project with the same number is not the repository", async () => {
    const res = await asHub({ repository_id: "3003" });
    expect([res.status, res.json.code]).toEqual([403, "project_not_registered"]);
    expect(ids.gitlab).not.toBe(ids.web);
  });

  test("a GitLab connection typed with github.com's address does not make a repository", async () => {
    const res = await asHub({ repository_id: "7007" });
    expect([res.status, res.json.code, ids.trick === ids.web]).toEqual([
      403,
      "project_not_registered",
      false,
    ]);
  });

  test("a repository of a GitHub Enterprise Server connection is not a github.com one", async () => {
    const res = await asHub({ repository_id: "2002" });
    expect([res.status, res.json.code]).toEqual([403, "project_not_registered"]);
  });

  test("a repository linked twice is ambiguous, and nobody gets either", async () => {
    const res = await asHub({ repository_id: "4004" });
    expect([res.status, res.json.code]).toEqual([409, "project_ambiguous"]);
    expect(ids.shared1).toBeDefined();
  });

  test("a GitLab token cannot reach a project linked through GitHub", async () => {
    const lab = await makeKey("lab");
    gitlab.setJwks([lab.jwk]);
    const res = await exchange(
      await sign(lab, {
        iss: gitlab.url,
        aud: AUDIENCE,
        sub: "project_path:acme/web",
        iat: seconds() - 5,
        exp: seconds() + 300,
        project_id: "1001",
        job_id: "1",
        ref: "main",
        ref_protected: "true",
      }),
    );
    expect([res.status, res.json.code]).toEqual([403, "project_not_registered"]);
  });
});

describe("a token that is not GitHub's, or not for this platform", () => {
  test("the wrong audience, an expired token and a token not yet valid are refused", async () => {
    for (const over of [
      { aud: "someone-else" },
      { exp: seconds() - 3600 },
      { nbf: seconds() + 3600 },
    ]) {
      const res = await asHub(over);
      expect([res.status, res.json.code]).toEqual([401, "invalid_id_token"]);
    }
  });

  test("a token signed by another key is refused, whatever it says it is", async () => {
    const res = await exchange(await sign(other, claims()));
    expect([res.status, res.json.code]).toEqual([401, "invalid_id_token"]);
  });

  test("GitHub's key does not sign for the deployment's GitLab", async () => {
    const res = await exchange(await sign(hub, claims({ iss: gitlab.url })));
    expect([res.status, res.json.code]).toEqual([401, "invalid_id_token"]);
  });

  test("a token with no repository, or one that is not a number, is refused", async () => {
    const none = await exchange(await sign(hub, without(claims(), "repository_id")));
    expect([none.status, none.json.code]).toEqual([401, "invalid_id_token"]);
    for (const repository_id of ["", "0", "-1", "1e3", "01001", "1001 ", 1001]) {
      const res = await asHub({ repository_id });
      expect([String(repository_id), res.status]).toEqual([String(repository_id), 401]);
    }
  });

  test("a deployment with no GitHub keys refuses GitHub's issuer without a call", async () => {
    const bare = createApp({
      logger,
      db: t.db,
      principal: callerPrincipal({ db: t.db }),
      ready: async () => {},
      ci: { key: async () => undefined, issuer: gitlab.url, audience: AUDIENCE },
    });
    const res = await bare.handle(
      new Request("http://localhost/auth/ci/exchange", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id_token: await sign(hub, claims()) }),
      }),
    );
    expect(res.status).toBe(401);
  });

  test("a refusal says nothing of the token, and the log has none of it", async () => {
    const token = await sign(other, claims());
    const res = await exchange(token);
    expect(res.text).not.toContain(token);
    expect(lines.some((l) => l.includes(token))).toBe(false);
    expect(lines.some((l) => l.includes(token.split(".")[2] ?? "never"))).toBe(false);
  });
});

describe("GitHub's keys cannot be fetched", () => {
  test("is a 502 and says so", async () => {
    up = false;
    const res = await asHub();
    up = true;
    expect([res.status, res.json.code]).toEqual([502, "github_unavailable"]);
  });
});
