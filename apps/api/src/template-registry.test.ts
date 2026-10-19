import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createConnection,
  createOrganization,
  createProject,
  createSession,
  savePipelineConfig,
  upsertUser,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createMockGitlab } from "@orch/gitlab/mock";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { COMPONENT_MAX_BYTES, REGISTRY_RELEASES, standing } from "./template-registry";
import { hashToken, randomToken } from "./tokens";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let conn1: string;
const roleTable = new Map<number, Pick<Subject, "orgRoles" | "projectRoles">>();
const people = {} as Record<"alice" | "bob" | "erin", { cookie: string }>;
type Who = keyof typeof people;
const lines: string[] = [];
const seen: string[] = [];

const makeApp = (provider: typeof keys | undefined) =>
  createApp({
    logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
    db: t.db,
    principal: callerPrincipal({
      db: t.db,
      roles: (u) => roleTable.get(u.gitlabId) ?? { orgRoles: {}, projectRoles: {} },
    }),
    ready: async () => {},
    keys: provider,
  });
let app: ReturnType<typeof makeApp>;

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  conn1 = (
    await createConnection(t.db, keys, {
      organizationId: o1,
      type: "gitlab",
      name: "live",
      config: { baseUrl: mock.url },
      token: mock.token,
    })
  ).id;
  let gitlabId = 900;
  for (const name of ["alice", "bob", "erin"] as const) {
    const user = await upsertUser(t.db, { gitlabId: ++gitlabId, username: name, name });
    const session = randomToken();
    await createSession(t.db, { userId: user.id, tokenHash: hashToken(session), ttlMs: 60_000 });
    people[name] = { cookie: `orch_session=${session}` };
  }
  roleTable.set(901, { orgRoles: { [o1]: "admin", [o2]: "admin" }, projectRoles: {} }); // alice
  roleTable.set(902, { orgRoles: { [o1]: "member" }, projectRoles: {} }); // bob
  // erin: nothing
  app = makeApp(keys);
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

async function get(who: Who | null, path: string, a = app) {
  const headers: Record<string, string> = {};
  if (who) headers.cookie = people[who].cookie;
  const res = await a.handle(new Request(`http://localhost${path}`, { headers }));
  const text = await res.text();
  seen.push(text);
  return {
    status: res.status,
    // biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
    json: (text ? JSON.parse(text) : undefined) as any,
  };
}

const registry = (project: string, who: Who | null = "alice", org = o1, connection = conn1) =>
  get(
    who,
    `/organizations/${org}/template-registry?project=${encodeURIComponent(project)}&connectionId=${connection}`,
  );

const component = (name: string, inputs = "") =>
  `spec:\n  inputs:${inputs || " {}"}\n---\n${name}:\n  script: [echo ${name}]\n`;
let n = 0;
/** A catalog project with the given tags; the files of a tag are its snapshot. */
function catalog(tags: Record<string, Record<string, string>>, files: Record<string, string> = {}) {
  const path = `fx/catalog${++n}`;
  mock.addProject({ path, files: { "README.md": "# c\n", ...files } });
  for (const [name, snapshot] of Object.entries(tags)) mock.addTag(path, name, snapshot);
  return path;
}

describe("GET /template-registry", () => {
  test("lists the releases newest first, each component with the releases that hold it and the inputs it has at the newest", async () => {
    const project = catalog({
      "1.0.0": { "templates/build.yml": component("build", "\n    old:") },
      "1.9.0": {
        "templates/build.yml": component(
          "build",
          "\n    bunVersion:\n      default: '1'\n    token:",
        ),
        "templates/lint/template.yml": component("lint"),
      },
      "1.10.0": {
        "templates/build.yml": component(
          "build",
          "\n    bunVersion:\n      default: '1'\n    ci:\n      type: boolean\n      default: true",
        ),
        "templates/lint/template.yml": component("lint"),
      },
      "v2.0.0": { "templates/build.yml": component("build") },
      nightly: { "templates/other.yml": component("other") },
    });
    const res = await registry(project);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      project,
      releases: ["1.10.0", "1.9.0", "1.0.0"],
      latest: "1.10.0",
      truncated: false,
      consumers: [],
      components: [
        {
          name: "build",
          versions: ["1.10.0", "1.9.0", "1.0.0"],
          inputs: [
            { name: "bunVersion", type: "string", required: false },
            { name: "ci", type: "boolean", required: false },
          ],
          problem: null,
        },
        { name: "lint", versions: ["1.10.0", "1.9.0"], inputs: [], problem: null },
      ],
    });
  });

  test("a component that cannot be read is reported on its own, its text is not copied, and the others are listed", async () => {
    const canary = `SEKRIT-component-${Bun.randomUUIDv7()}`;
    const project = catalog({
      "1.0.0": {
        "templates/good.yml": component("good", "\n    x:"),
        "templates/broken.yml": `spec: [\n  ${canary}`,
        "templates/nospec.yml": `${canary}:\n  script: [x]\n`,
        "templates/empty.yml": "spec:\n  inputs: {}\n---\n",
        "templates/big.yml": `${component("big")}# ${"x".repeat(COMPONENT_MAX_BYTES)}\n`,
        "templates/Bad Name.yml": component("bad"),
        "templates/notes.md": canary,
      },
    });
    const res = await registry(project);
    expect(res.status).toBe(200);
    const by = Object.fromEntries(
      res.json.components.map((c: { name: string }) => [c.name, c]),
    ) as Record<string, { problem: string | null; inputs: unknown[] }>;
    expect(Object.keys(by).sort()).toEqual(["big", "broken", "empty", "good", "nospec"]);
    expect(by.good).toMatchObject({ problem: null, inputs: [{ name: "x" }] });
    expect(by.broken?.problem).toBe("the file is not valid YAML");
    expect(by.nospec?.problem).toBe(
      "the file needs a spec: inputs: header, then ---, then the jobs",
    );
    expect(by.empty?.problem).toBe("the file has no jobs after the ---");
    expect(by.big?.problem).toBe("the file is larger than 64 KiB");
    for (const c of Object.values(by).filter((c) => c.problem)) expect(c.inputs).toEqual([]);
    expect(JSON.stringify(res.json)).not.toContain(canary);
  });

  test("a project with no releases lists none; only the newest releases are read, and it says so", async () => {
    expect((await registry(catalog({ nightly: {} }))).json).toMatchObject({
      releases: [],
      latest: null,
      truncated: false,
      components: [],
    });

    const tags: Record<string, Record<string, string>> = {};
    for (let i = 1; i <= REGISTRY_RELEASES + 2; i++)
      tags[`1.${i}.0`] = {
        "templates/new.yml": component("new"),
        ...(i <= 2 ? { "templates/oldest.yml": component("oldest") } : {}),
      };
    const res = await registry(catalog(tags));
    expect(res.json.releases).toHaveLength(REGISTRY_RELEASES + 2);
    expect(res.json.truncated).toBe(true);
    expect(res.json.components.map((c: { name: string }) => c.name)).toEqual(["new"]);
    expect(res.json.components[0].versions).toHaveLength(REGISTRY_RELEASES);
  });

  test("lists the organization's projects that use the catalog and where each stands: up to date, behind, unpinned, unpublished", async () => {
    const files = { "templates/a.yml": component("a") };
    const project = catalog({ "1.0.0": files, "1.2.0": files, "1.2.5": files, "2.1.0": files });
    const other = catalog({ "1.0.0": files });
    const o2Conn = (
      await createConnection(t.db, keys, {
        organizationId: o2,
        type: "gitlab",
        name: "two",
        config: { baseUrl: mock.url },
        token: mock.token,
      })
    ).id;
    const use = async (
      org: string,
      connection: string,
      name: string,
      includeProject: string,
      includeRef: string | null,
      mode: "include" | "component" = "include",
    ) => {
      const p = await createProject(t.db, { organizationId: org, name });
      await savePipelineConfig(t.db, {
        organizationId: org,
        projectId: p.id,
        connectionId: connection,
        template: "bun-app",
        version: "1.0.0",
        params: {},
        overrides: {},
        renderedHash: "a".repeat(64),
        mode,
        includeProject,
        includeRef,
        mrIid: null,
        mrUrl: null,
      });
      return p.id;
    };
    const id = {
      current: await use(o1, conn1, "c-current", project, "2.1.0", "component"),
      behind: await use(o1, conn1, "b-behind", project, "1.2.5", "component"),
      major: await use(o1, conn1, "d-major", project, "1", "component"),
      partial: await use(o1, conn1, "c-partial", project, "2", "component"),
      minor: await use(o1, conn1, "e-minor", project, "1.2", "component"),
      gone: await use(o1, conn1, "f-gone", project, "3.0.0", "component"),
      none: await use(o1, conn1, "g-none", project, null),
      branch: await use(o1, conn1, "h-branch", project, "main"),
      elsewhere: await use(o1, conn1, "i-elsewhere", other, "1.0.0"),
      foreign: await use(o2, o2Conn, "j-foreign", project, "1.0.0"),
    };
    const res = await registry(project);
    expect(res.status).toBe(200);
    expect(
      res.json.consumers.map((c: { projectName: string; standing: string }) => [
        c.projectName,
        c.standing,
      ]),
    ).toEqual([
      ["b-behind", "behind"],
      ["c-current", "up_to_date"],
      ["c-partial", "up_to_date"],
      ["d-major", "behind"],
      ["e-minor", "behind"],
      ["f-gone", "unpublished"],
      ["g-none", "unpinned"],
      ["h-branch", "unpinned"],
    ]);
    expect(res.json.consumers[0]).toEqual({
      projectId: id.behind,
      projectName: "b-behind",
      template: "bun-app",
      mode: "component",
      ref: "1.2.5",
      standing: "behind",
    });
    expect(res.json.consumers[6]).toMatchObject({ projectId: id.none, mode: "include", ref: null });
    const ids = res.json.consumers.map((c: { projectId: string }) => c.projectId);
    expect(ids).not.toContain(id.elsewhere); // another catalog
    expect(ids).not.toContain(id.foreign); // another organization
    // a catalog with no releases publishes nothing the consumers could follow
    const unreleased = catalog({ nightly: {} });
    await use(o1, conn1, "k-unreleased", unreleased, "1.0.0");
    expect((await registry(unreleased)).json.consumers).toMatchObject([
      { projectName: "k-unreleased", standing: "unpublished" },
    ]);
  });

  test("a ref stands as: a release or a partial one follows the newest it matches; anything else follows no release", () => {
    const releases = ["2.0.1", "2.0.0", "1.10.0", "1.9.3"];
    const at = (ref: string | null) => standing(ref, releases);
    expect([at("2.0.1"), at("2"), at("2.0")]).toEqual(["up_to_date", "up_to_date", "up_to_date"]);
    expect([at("1.10.0"), at("1.9.3"), at("1"), at("1.10"), at("1.9")]).toEqual(
      Array(5).fill("behind"),
    );
    expect([at("1.9.4"), at("3"), at("1.11"), at("2.0.2")]).toEqual(Array(4).fill("unpublished"));
    expect([at(null), at("main"), at("~latest"), at("v2.0.1"), at("a".repeat(40))]).toEqual(
      Array(5).fill("unpinned"),
    );
    expect(standing("1.0.0", [])).toBe("unpublished");
  });

  test("a project GitLab does not show to the connection's token is a 422, and a bad path is refused before GitLab is asked", async () => {
    const missing = await registry("fx/not-there");
    expect(missing.status).toBe(422);
    expect(missing.json.code).toBe("gitlab_project_unreachable");
    const before = mock.requests.length;
    for (const project of ["x", "../x/y", "a/b c", "a/./b", `a/${"b".repeat(300)}`]) {
      expect((await registry(project)).status).toBe(422);
    }
    expect(mock.requests.length).toBe(before);
  });

  test("an organization admin only: a member is refused, a stranger sees nothing, no session is 401, and another organization's connection is not usable", async () => {
    const project = catalog({ "1.0.0": { "templates/a.yml": component("a") } });
    const before = mock.requests.length;
    expect((await registry(project, "bob")).status).toBe(403);
    expect((await registry(project, "erin")).status).toBe(404); // a non-member cannot tell the organization exists
    expect((await registry(project, null)).status).toBe(401);
    expect(mock.requests.length).toBe(before);
    // alice is an admin of o2 too, but conn1 belongs to o1
    expect((await registry(project, "alice", o2)).status).toBe(404);
    expect((await registry(project)).status).toBe(200);
  });

  test("without master keys the connection cannot be opened: 503, and nothing is asked of GitLab", async () => {
    const before = mock.requests.length;
    const res = await get(
      "alice",
      `/organizations/${o1}/template-registry?project=fx%2Fa&connectionId=${conn1}`,
      makeApp(undefined),
    );
    expect(res.status).toBe(503);
    expect(mock.requests.length).toBe(before);
  });

  test("the connection's token is in no response and no log line", async () => {
    await registry(catalog({ "1.0.0": { "templates/a.yml": component("a") } }));
    await registry("fx/not-there");
    for (const text of [...seen, ...lines]) expect(text.includes(mock.token)).toBe(false);
  });
});
