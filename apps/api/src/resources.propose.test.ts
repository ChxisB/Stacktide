import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BlueprintSchema, createLogger, type ProjectRole, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  createSession,
  listResources,
  savePipelineConfig,
  upsertResource,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { githubForge, gitlabForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { renderBlueprint } from "@orch/iac";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { RESOURCE_ROOT, resourceBranch } from "./resource-propose";
import { hashToken, randomToken } from "./tokens";

// BLP-16: asking for a resource opens a merge or pull request in the project's own repository. The forge
// is a mock, and the platform makes no cloud call.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const TOKEN = "ghp_not-a-real-token-1234";
const bucket = {
  kind: "bucket",
  cloud: "gcp",
  environment: "staging",
  name: "files",
  region: "us-central1",
  project: "my-proj-1234",
};
const BRANCH = resourceBranch("staging-files-bucket");

let t: TestDb;
let hub: ReturnType<typeof createMockGithub>;
let lab: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let github: string;
let gitlab: string;
let app: ReturnType<typeof createApp>;
type Roles = Pick<Subject, "orgRoles" | "projectRoles">;
const roleTable = new Map<number, Roles>();
const people = {} as Record<
  "owner" | "admin" | "member" | "viewer" | "maintainer" | "developer" | "reporter" | "outsider",
  string
>;
const gitlabIds = {} as Record<keyof typeof people, number>;

beforeAll(async () => {
  t = await createTestDb();
  hub = createMockGithub({ token: TOKEN });
  lab = createMockGitlab({ scopes: ["api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  let gitlabId = 1100;
  for (const [name, roles] of [
    ["owner", { orgRoles: { [o1]: "owner" }, projectRoles: {} }],
    ["admin", { orgRoles: { [o1]: "admin" }, projectRoles: {} }],
    ["member", { orgRoles: { [o1]: "member" }, projectRoles: {} }],
    ["viewer", { orgRoles: { [o1]: "viewer" }, projectRoles: {} }],
    // no role in the organization: a role on the project only, given when the project is made
    ["maintainer", { orgRoles: {}, projectRoles: {} }],
    ["developer", { orgRoles: {}, projectRoles: {} }],
    ["reporter", { orgRoles: {}, projectRoles: {} }],
    ["outsider", { orgRoles: { [o2]: "admin" }, projectRoles: {} }],
  ] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = `orch_session=${session}`;
    gitlabIds[name] = gitlabId;
    roleTable.set(gitlabId, roles as unknown as Roles);
  }
  app = createApp({
    logger: createLogger({ level: "debug", write: () => {} }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys,
    loopbackConnections: true,
  });
  const connect = async (type: string, baseUrl: string, token: string) =>
    (
      await createConnection(t.db, keys, {
        organizationId: o1,
        type,
        name: type,
        config: { baseUrl },
        token,
      })
    ).id;
  github = await connect("github", hub.url, TOKEN);
  gitlab = await connect("gitlab", lab.url, lab.token);
});
afterAll(async () => {
  hub.stop();
  lab.stop();
  await t.drop();
});

let n = 0;
/** A project linked to a mock repository on `kind`; by default it has the pipeline the platform sets up. */
async function world(
  kind: "github" | "gitlab" = "github",
  options: { pipeline?: boolean; linked?: boolean; files?: Record<string, string> } = {},
) {
  const { pipeline = true, linked = true, files } = options;
  const name = `svc${++n}`;
  const repo =
    kind === "github"
      ? hub.addRepo("acme", name, { files })
      : lab.addProject({ path: `fx/${name}`, files });
  const connectionId = kind === "github" ? github : gitlab;
  const project = await createProject(t.db, {
    organizationId: o1,
    name,
    ...(linked ? { gitlabProjectId: repo.id } : {}),
    connectionId,
  });
  if (pipeline) {
    await savePipelineConfig(t.db, {
      organizationId: o1,
      projectId: project.id,
      connectionId,
      template: "bun-app",
      version: "1.0.0",
      params: {},
      overrides: {},
      renderedHash: "0".repeat(64),
      mode: "inline",
      includeProject: null,
      includeRef: null,
      mrIid: null,
      mrUrl: null,
    });
  }
  for (const [who, role] of [
    ["maintainer", "maintainer"],
    ["developer", "developer"],
    ["reporter", "reporter"],
  ] as [keyof typeof people, ProjectRole][]) {
    const roles = roleTable.get(gitlabIds[who]);
    if (roles) (roles.projectRoles as Record<string, ProjectRole>)[project.id] = role;
  }
  const base = `/organizations/${o1}/projects/${project.id}/resources`;
  const send = async (
    who: keyof typeof people | undefined,
    method: "POST" | "PATCH",
    path: string,
    body: unknown,
  ) => {
    const res = await app.handle(
      new Request(`http://localhost${base}${path}`, {
        method,
        headers: { ...(who ? { cookie: people[who] } : {}), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as any };
  };
  /** Anything written to the repository: a commit, a branch, a request. */
  const writes = () =>
    kind === "github"
      ? hub.requests.filter((r) => r.method !== "GET" && r.path.includes(name))
      : lab.requests.filter((r) => r.method !== "GET" && r.path.includes(`/projects/${repo.id}`));
  const forge =
    kind === "github"
      ? githubForge(
          createGithubClient({
            baseUrl: hub.url,
            allowInsecureHttp: true,
            token: TOKEN,
            maxRetries: 0,
          }),
        )
      : gitlabForge(
          createGitlab({
            baseUrl: lab.url,
            auth: { type: "private-token", token: lab.token },
            maxRetries: 0,
          }),
        );
  const file = (path: string, ref: string) =>
    forge.repository.getFile(repo.id, path, ref).then(
      (f) => f.content,
      () => null,
    );
  const rows = () => listResources(t.db, o1, project.id, { limit: 100 });
  const events = async () =>
    (await t.db.select().from(auditEvents)).filter(
      (e) => e.action === "resource.propose" && e.projectId === project.id,
    );
  return {
    kind,
    repo,
    project,
    base,
    writes,
    file,
    rows,
    events,
    add: (who: keyof typeof people | undefined, body: unknown = bucket) =>
      send(who, "POST", "", body),
    change: (who: keyof typeof people | undefined, id: string, body: unknown) =>
      send(who, "PATCH", `/${id}`, body),
    preview: (who: keyof typeof people | undefined, body: unknown = bucket) =>
      send(who, "POST", "/preview", body),
  };
}

describe("asking for a resource", () => {
  for (const kind of ["github", "gitlab"] as const) {
    test(`on ${kind}: a maintainer opens one request with the files, and the row and the audit event are left`, async () => {
      const w = await world(kind);
      const res = await w.add("maintainer");

      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({
        organizationId: o1,
        projectId: w.project.id,
        environment: "staging",
        kind: "bucket",
        cloud: "gcp",
        name: "files",
        stack: "staging-files-bucket",
        path: "infra/staging/files-bucket",
        state: "proposed",
        outcome: "opened",
        committed: true,
      });
      expect(res.json.proposalUrl).toContain(kind === "github" ? "/pull/" : "/merge_requests/");
      // the branch holds the files the renderer writes; the default branch holds none
      const want = renderBlueprint(bucket, kind, RESOURCE_ROOT, []);
      if (!want.ok) throw new Error("did not render");
      for (const f of want.files) {
        expect([f.path, await w.file(f.path, BRANCH)]).toEqual([f.path, f.content]);
        expect([f.path, await w.file(f.path, "main")]).toEqual([f.path, null]);
      }
      expect(res.json.files).toEqual(want.files.map((f) => f.path));

      const [row] = await w.rows();
      expect(row).toMatchObject({ id: res.json.id, stack: "staging-files-bucket", cloud: "gcp" });
      expect(row?.proposalUrl).toBe(res.json.proposalUrl);

      // audited with what and where, never with the files' text
      const [event] = await w.events();
      expect(event).toMatchObject({ resourceType: "resource", resourceId: res.json.id });
      expect(event?.metadata).toMatchObject({
        kind: "bucket",
        cloud: "gcp",
        name: "files",
        environment: "staging",
        outcome: "opened",
        files: want.files.map((f) => f.path),
      });
      expect(JSON.stringify(event?.metadata)).not.toContain('module "this"');
      expect(res.text).not.toContain(TOKEN);
    });
  }

  test("asking again for the same thing updates nothing, answers 200 with the same resource, and is audited", async () => {
    const w = await world();
    const first = await w.add("maintainer");
    const writes = w.writes().length;
    const again = await w.add("maintainer");

    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: first.json.id, outcome: "unchanged", committed: false });
    expect(again.json.proposalUrl).toBe(first.json.proposalUrl);
    expect(w.writes()).toHaveLength(writes);
    expect(await w.rows()).toHaveLength(1);
    expect(await w.events()).toHaveLength(2);
  });

  test("asking again once the files are on the default branch commits nothing and keeps the link to the request that carried them", async () => {
    const want = renderBlueprint(bucket, "github", RESOURCE_ROOT, []);
    if (!want.ok) throw new Error("did not render");
    // the request was merged: the repository already holds what it carried
    const w = await world("github", {
      files: Object.fromEntries(want.files.map((f) => [f.path, f.content])),
    });
    const link = "https://github.example/acme/merged/pull/9";
    await upsertResource(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      environment: "staging",
      kind: "bucket",
      cloud: "gcp",
      name: "files",
      inputs: BlueprintSchema.parse(bucket),
      stack: want.stack,
      path: want.dir,
      proposalUrl: link,
    });
    const again = await w.add("maintainer");

    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ outcome: "in_place", committed: false, proposalUrl: link });
    expect((await w.rows())[0]?.proposalUrl).toBe(link);
    expect(w.writes()).toHaveLength(0);
  });

  test("changing it commits on the same branch, edits the same request and stores the new inputs", async () => {
    const w = await world();
    const first = await w.add("maintainer");
    const res = await w.change("maintainer", first.json.id, { ...bucket, versioning: true });

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      id: first.json.id,
      outcome: "updated",
      committed: true,
      proposalUrl: first.json.proposalUrl,
      inputs: { versioning: true },
    });
    const [row] = await w.rows();
    expect(row?.inputs).toMatchObject({ versioning: true });
    expect(await w.rows()).toHaveLength(1);
    const want = renderBlueprint({ ...bucket, versioning: true }, w.kind, RESOURCE_ROOT, []);
    if (!want.ok) throw new Error("did not render");
    const main = want.files.find((f) => f.path.endsWith("/main.tf"));
    expect(await w.file(main?.path ?? "", BRANCH)).toBe(main?.content ?? "");
  });

  test("a change cannot rename or move the resource: the key is named and nothing is written", async () => {
    const w = await world();
    const first = await w.add("maintainer");
    const writes = w.writes().length;
    for (const key of ["name", "environment", "kind"] as const) {
      const other = key === "kind" ? "network" : "other";
      const body =
        key === "kind"
          ? {
              kind: "network",
              cloud: "gcp",
              environment: "staging",
              name: "files",
              region: "us-central1",
              project: "my-proj-1234",
            }
          : { ...bucket, [key]: other };
      const res = await w.change("maintainer", first.json.id, body);
      expect([key, res.status, res.json.code]).toEqual([key, 422, "invalid_resource"]);
      expect(res.json.errors.map((e: { path: string }) => e.path)).toContain(key);
    }
    expect(w.writes()).toHaveLength(writes);
    expect(await w.rows()).toHaveLength(1);
  });

  test("a change to another project's resource, or to one that is not there, is a 404", async () => {
    const w = await world();
    const other = await world();
    const theirs = await other.add("maintainer");
    expect((await w.change("maintainer", theirs.json.id, bucket)).status).toBe(404);
    expect((await w.change("maintainer", crypto.randomUUID(), bucket)).status).toBe(404);
    expect(w.writes()).toEqual([]);
  });

  test("the same name on the other cloud is a 409: a resource does not move between clouds", async () => {
    const w = await world();
    await w.add("maintainer");
    const writes = w.writes().length;
    const res = await w.add("maintainer", {
      ...bucket,
      cloud: "aws",
      region: "eu-west-2",
      project: undefined,
    });
    expect([res.status, res.json.code]).toEqual([409, "resource_cloud"]);
    expect(w.writes()).toHaveLength(writes);
    expect((await w.rows())[0]?.cloud).toBe("gcp");
  });

  test("what a resource uses must be a resource of the project: loaded, parsed and checked", async () => {
    const w = await world();
    const service = {
      kind: "service",
      cloud: "gcp",
      environment: "staging",
      name: "api",
      region: "us-central1",
      project: "my-proj-1234",
      uses: ["bucket:files"],
    };
    const missing = await w.add("maintainer", service);
    expect([missing.status, missing.json.code]).toEqual([422, "invalid_resource"]);
    expect(missing.json.errors).toEqual([
      { path: "uses", message: "bucket:files is not a resource of staging" },
    ]);
    expect(w.writes()).toEqual([]);

    expect((await w.add("maintainer")).status).toBe(201);
    const found = await w.add("maintainer", service);
    expect(found.status).toBe(201);
    expect(found.json.stack).toBe("staging-api-service");
    const main = await w.file(
      "infra/staging/api-service/main.tf",
      resourceBranch("staging-api-service"),
    );
    expect(main).toContain("bucket");
  });

  for (const kind of ["github", "gitlab"] as const) {
    test(`on ${kind}: a deploy identity for a service of the project is opened and recorded, and one for a service that is not is refused`, async () => {
      const w = await world(kind);
      const service = {
        kind: "service",
        cloud: "gcp",
        environment: "staging",
        name: "web",
        region: "us-central1",
        project: "my-proj-1234",
      };
      const identity = {
        kind: "deploy-identity",
        cloud: "gcp",
        environment: "staging",
        name: "main",
        region: "us-central1",
        project: "my-proj-1234",
        forge: kind,
        repository: "acme/web",
        repositoryId: 1234567,
        ownerId: 7654321,
        ...(kind === "gitlab" ? { branch: "main" } : {}),
        uses: ["service:web"],
      };
      const missing = await w.add("maintainer", identity);
      expect(missing.json.errors).toEqual([
        { path: "uses", message: "service:web is not a resource of staging" },
      ]);
      expect(w.writes()).toEqual([]);

      expect((await w.add("maintainer", service)).status).toBe(201);
      const res = await w.add("maintainer", identity);
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({
        kind: "deploy-identity",
        stack: "staging-main-deploy-identity",
      });
      // the deploy identity is applied after the service it names
      const stack = await w.file(
        "infra/staging/main-deploy-identity/stack.yml",
        resourceBranch("staging-main-deploy-identity"),
      );
      expect(stack).toContain("staging-web-service");
      expect((await w.rows()).map((r) => r.kind).sort()).toEqual(["deploy-identity", "service"]);
    });
  }

  test("two names that run together into one stack name are refused, naming the key", async () => {
    const w = await world();
    expect(
      (await w.add("maintainer", { ...bucket, environment: "dev-eu", name: "main" })).status,
    ).toBe(201);
    const res = await w.add("maintainer", { ...bucket, environment: "dev", name: "eu-main" });
    expect([res.status, res.json.code]).toEqual([422, "invalid_resource"]);
    expect(res.json.errors[0].path).toBe("name");
    expect(await w.rows()).toHaveLength(1);
  });
});

describe("a request that cannot succeed writes nothing", () => {
  test("an input the schema refuses is a 422 that names the key and the reason", async () => {
    const w = await world();
    const res = await w.add("maintainer", { ...bucket, region: "moon" });

    expect([res.status, res.json.code]).toEqual([422, "invalid_resource"]);
    expect(res.json.errors).toEqual([
      { path: "region", message: expect.stringContaining("GCP region") },
    ]);
    expect(res.json.detail).toContain("region");
    expect(w.writes()).toEqual([]);
    expect(await w.rows()).toEqual([]);
    expect(await w.events()).toEqual([]);
  });

  test("a key the schema does not know is named, and the value sent with it is not echoed", async () => {
    const w = await world();
    const res = await w.add("maintainer", { ...bucket, password: "hunter2-not-a-real-one" });
    expect(res.status).toBe(422);
    expect(res.text).toContain("password");
    expect(res.text).not.toContain("hunter2-not-a-real-one");
    expect(w.writes()).toEqual([]);
  });

  test("a body that is not an object is refused", async () => {
    const w = await world();
    for (const body of ["text", 7, null, [bucket]]) {
      const res = await w.add("maintainer", body);
      expect([JSON.stringify(body), res.status >= 400 && res.status < 500]).toEqual([
        JSON.stringify(body),
        true,
      ]);
    }
    expect(w.writes()).toEqual([]);
  });

  test("a project with no stack pipeline is told to set it up first", async () => {
    const w = await world("github", { pipeline: false });
    const res = await w.add("maintainer");
    expect([res.status, res.json.code]).toEqual([422, "no_pipeline"]);
    expect(res.json.detail).toContain("pipeline");
    expect(w.writes()).toEqual([]);
    expect(await w.rows()).toEqual([]);
  });

  test("a project that is not linked to a repository is a 422", async () => {
    const w = await world("github", { linked: false });
    const res = await w.add("maintainer");
    expect([res.status, res.json.code]).toEqual([422, "not_linked"]);
    expect(await w.rows()).toEqual([]);
  });

  test("a forge that fails is a 502, and no row or audit event is left behind", async () => {
    const w = await world();
    hub.inject({ method: "GET", path: `/repositories/${w.repo.id}`, status: 500, times: 2 });
    const res = await w.add("maintainer");
    expect([res.status, res.json.code]).toEqual([502, "gitlab_failed"]);
    expect(res.text).not.toContain(TOKEN);
    expect(await w.rows()).toEqual([]);
    expect(await w.events()).toEqual([]);
  });
});

describe("who may ask", () => {
  test("a project maintainer, an org admin and an org owner may", async () => {
    for (const who of ["maintainer", "admin", "owner"] as const) {
      const w = await world();
      const res = await w.add(who);
      expect([who, res.status]).toEqual([who, 201]);
    }
  });

  test("a developer, a reporter, an org member and an org viewer may not, and nothing is written", async () => {
    for (const who of ["developer", "reporter", "member", "viewer"] as const) {
      const w = await world();
      const res = await w.add(who);
      expect([who, res.status]).toEqual([who, 403]);
      expect(w.writes()).toEqual([]);
      expect(await w.rows()).toEqual([]);
    }
  });

  test("someone from another organization is told there is no such project, and anyone not signed in is a 401", async () => {
    const w = await world();
    expect((await w.add("outsider")).status).toBe(404);
    expect((await w.add(undefined)).status).toBe(401);
    const first = await w.add("maintainer");
    expect((await w.change("outsider", first.json.id, bucket)).status).toBe(404);
    expect((await w.change("developer", first.json.id, bucket)).status).toBe(403);
    expect((await w.change(undefined, first.json.id, bucket)).status).toBe(401);
  });
});

// BLP-19: `orch resource add --dry-run` asks what a request would hold. The same checks run, the forge is not
// asked, and nothing is stored.
describe("asking what a resource would hold", () => {
  test("answers the stack and the files, writes nothing and leaves no row or audit event", async () => {
    for (const kind of ["github", "gitlab"] as const) {
      const w = await world(kind);
      const res = await w.preview("maintainer");
      const want = renderBlueprint(bucket, kind, RESOURCE_ROOT, []);
      if (!want.ok) throw new Error("did not render");
      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        verb: "add",
        cloud: "gcp",
        stack: "staging-files-bucket",
        path: "infra/staging/files-bucket",
        files: want.files.map((f) => f.path),
        idleCost: expect.any(String),
      });
      expect(w.writes()).toEqual([]);
      expect(await w.rows()).toEqual([]);
      expect(await w.events()).toEqual([]);
    }
  });

  test("says `change` once the resource is recorded", async () => {
    const w = await world("gitlab");
    await w.add("maintainer");
    expect((await w.preview("maintainer")).json.verb).toBe("change");
  });

  test("refuses what a real request would: a key, the other cloud, no pipeline, no link", async () => {
    const w = await world();
    const bad = await w.preview("maintainer", { ...bucket, region: "nowhere" });
    expect(bad.status).toBe(422);
    expect(bad.json.errors).toEqual([expect.objectContaining({ path: "region" })]);

    await w.add("maintainer");
    expect(
      (await w.preview("maintainer", { ...bucket, cloud: "aws", region: "eu-west-2" })).status,
    ).toBe(422);
    const same = await w.preview("maintainer", {
      kind: "bucket",
      cloud: "aws",
      environment: "staging",
      name: "files",
      region: "eu-west-2",
    });
    expect(same.status).toBe(409);
    expect((await (await world("github", { pipeline: false })).preview("maintainer")).status).toBe(
      422,
    );
    expect((await (await world("github", { linked: false })).preview("maintainer")).status).toBe(
      422,
    );
  });

  test("is for those who may ask: a developer is refused, another organization is told there is no project, anyone else is a 401", async () => {
    const w = await world();
    expect((await w.preview("developer")).status).toBe(403);
    expect((await w.preview("reporter")).status).toBe(403);
    expect((await w.preview("outsider")).status).toBe(404);
    expect((await w.preview(undefined)).status).toBe(401);
  });
});
