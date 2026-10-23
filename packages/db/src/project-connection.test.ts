import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq } from "drizzle-orm";
import { projectsByGitlabId, projectsOfIssuer } from "./ci";
import { createConnection, deleteConnection } from "./connections";
import { importProject, linkedProjects } from "./imports";
import { pgConstraint } from "./pg-error";
import { connectionsByIssuer, connectionsOfProject } from "./project-connection";
import { createOrganization, createProject } from "./repo";
import { projects } from "./schema";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
let n = 0;
const org = () => createOrganization(t.db, { slug: `o${++n}`, name: "O" });
const connect = (organizationId: string, type = "gitlab") =>
  createConnection(t.db, keys, { organizationId, type, name: `c${++n}`, token: "glpat-x" });
const imp = (
  organizationId: string,
  connectionId: string | undefined,
  over: Partial<Parameters<typeof importProject>[1]> = {},
) =>
  importProject(t.db, {
    organizationId,
    connectionId,
    gitlabProjectId: 42,
    name: `repo${++n}`,
    defaultBranch: "main",
    types: [],
    ...over,
  });

describe("a project knows its connection", () => {
  test("two connections of one organization can each hold project 42", async () => {
    const o = await org();
    const [a, b] = [await connect(o.id), await connect(o.id)];
    const [pa, pb] = [await imp(o.id, a.id), await imp(o.id, b.id)];
    expect([pa.created, pb.created]).toEqual([true, true]);
    expect(pa.project.id).not.toBe(pb.project.id);
    expect([pa.project.connectionId, pb.project.connectionId]).toEqual([a.id, b.id]);
    // The same connection importing it again is a refresh.
    const again = await imp(o.id, a.id);
    expect([again.created, again.project.id]).toEqual([false, pa.project.id]);
    expect((await projectsByGitlabId(t.db, 42, a.id)).map((p) => p.id)).toEqual([pa.project.id]);
    expect((await projectsByGitlabId(t.db, 42, b.id)).map((p) => p.id)).toEqual([pb.project.id]);
  });

  test("the same id twice under one connection, or twice unbound, is still refused", async () => {
    const o = await org();
    const a = await connect(o.id);
    const bound = (name: string) =>
      t.db.insert(projects).values({
        organizationId: o.id,
        connectionId: a.id,
        gitlabProjectId: 7,
        name,
      });
    await bound("one");
    expect(pgConstraint(await bound("two").catch((e) => e))).toBe(
      "projects_connection_gitlab_project_key",
    );
    await createProject(t.db, { organizationId: o.id, name: "u1", gitlabProjectId: 8 });
    const e = await createProject(t.db, {
      organizationId: o.id,
      name: "u2",
      gitlabProjectId: 8,
    }).catch((x) => x);
    expect(pgConstraint(e)).toBe("projects_org_gitlab_project_key");
  });

  test("a connection of another organization is refused", async () => {
    const [o, other] = [await org(), await org()];
    const c = await connect(other.id);
    const e = await imp(o.id, c.id).catch((x) => x);
    expect(pgConstraint(e)).toBe("projects_connection_org_fk");
  });

  test("a connection with projects cannot be deleted, one without can", async () => {
    const o = await org();
    const [used, free] = [await connect(o.id), await connect(o.id)];
    await imp(o.id, used.id);
    const e = await deleteConnection(t.db, o.id, used.id).catch((x) => x);
    expect(pgConstraint(e)).toBe("projects_connection_org_fk");
    expect(await deleteConnection(t.db, o.id, free.id)).toBe(true);
  });

  test("an unbound project belongs to the organization's only connection, and to none of two", async () => {
    const o = await org();
    const legacy = await createProject(t.db, {
      organizationId: o.id,
      name: "legacy",
      gitlabProjectId: 4242,
    });
    expect(await connectionsOfProject(t.db, legacy.id)).toEqual([]);
    const a = await connect(o.id);
    expect(await connectionsOfProject(t.db, legacy.id)).toEqual([a.id]);
    expect((await projectsByGitlabId(t.db, 4242, a.id)).map((p) => p.id)).toEqual([legacy.id]);
    expect(await linkedProjects(t.db, o.id, [4242], a.id)).toEqual([
      { id: legacy.id, gitlabProjectId: 4242 },
    ]);

    const b = await connect(o.id);
    expect(await connectionsOfProject(t.db, legacy.id)).toHaveLength(2);
    expect(await projectsByGitlabId(t.db, 4242, a.id)).toEqual([]);
    expect(await projectsByGitlabId(t.db, 4242, b.id)).toEqual([]);
    expect(await linkedProjects(t.db, o.id, [4242], b.id)).toEqual([]);
    // Without a connection the lookups answer as they always did.
    expect(await projectsByGitlabId(t.db, 4242)).toHaveLength(1);
    expect(await linkedProjects(t.db, o.id, [4242])).toHaveLength(1);
  });

  test("a connection of another type does not make an unbound project ambiguous", async () => {
    const o = await org();
    const legacy = await createProject(t.db, {
      organizationId: o.id,
      name: "legacy",
      gitlabProjectId: 42,
    });
    const gl = await connect(o.id);
    const gh = await connect(o.id, "github");
    expect(await connectionsOfProject(t.db, legacy.id)).toEqual([gl.id]);
    // An unbound project is a GitLab one: the lone GitHub connection does not own it.
    expect(await linkedProjects(t.db, o.id, [42], gh.id)).toEqual([]);
    expect(await linkedProjects(t.db, o.id, [42], gl.id)).toHaveLength(1);
  });

  test("a lookup with no connection finds GitLab's projects only: a GitHub repository with the same number is not one (FRG-15)", async () => {
    const o = await org();
    const [gl, gh] = [await connect(o.id), await connect(o.id, "github")];
    const lab = await imp(o.id, gl.id, { gitlabProjectId: 555 });
    const hub = await imp(o.id, gh.id, { gitlabProjectId: 555, name: "acme/widgets" });
    const legacy = await createProject(t.db, {
      organizationId: o.id,
      name: "legacy",
      gitlabProjectId: 556,
    });
    // the webhook handlers ask without a connection: the event is GitLab's
    expect((await linkedProjects(t.db, o.id, [555])).map((p) => p.id)).toEqual([lab.project.id]);
    expect((await linkedProjects(t.db, o.id, [556])).map((p) => p.id)).toEqual([legacy.id]);
    // asked by its own connection, the repository is found
    expect((await linkedProjects(t.db, o.id, [555], gh.id)).map((p) => p.id)).toEqual([
      hub.project.id,
    ]);
  });

  test("a GitHub repository and a GitLab project of one organization can share a number (FRG-10)", async () => {
    const o = await org();
    const [gl, gh] = [await connect(o.id), await connect(o.id, "github")];
    const lab = await imp(o.id, gl.id, { gitlabProjectId: 123456 });
    // a repository's numeric id sits in the same column, its owner/name where a GitLab project's path would be
    const hub = await imp(o.id, gh.id, { gitlabProjectId: 123456, name: "acme/widgets" });
    expect([lab.created, hub.created]).toEqual([true, true]);
    expect(lab.project.id).not.toBe(hub.project.id);
    expect((await projectsByGitlabId(t.db, 123456, gh.id)).map((p) => p.id)).toEqual([
      hub.project.id,
    ]);
    expect((await projectsByGitlabId(t.db, 123456, gl.id)).map((p) => p.id)).toEqual([
      lab.project.id,
    ]);
    // and the same repository twice under its connection is one project
    expect((await imp(o.id, gh.id, { gitlabProjectId: 123456 })).created).toBe(false);
  });

  test("a bound project answers with its own connection, whatever else the organization has", async () => {
    const o = await org();
    const [a] = [await connect(o.id), await connect(o.id)];
    const { project } = await imp(o.id, a.id);
    expect(await connectionsOfProject(t.db, project.id)).toEqual([a.id]);
  });

  test("an import adopts an unbound project when the connection is the only one", async () => {
    const o = await org();
    const legacy = await createProject(t.db, {
      organizationId: o.id,
      name: "legacy",
      gitlabProjectId: 42,
    });
    const a = await connect(o.id);
    const { project, created } = await imp(o.id, a.id, { name: "from-gitlab" });
    expect([created, project.id, project.name, project.connectionId]).toEqual([
      false,
      legacy.id,
      "legacy",
      a.id,
    ]);
    expect(
      await t.db.select().from(projects).where(eq(projects.organizationId, o.id)),
    ).toHaveLength(1);
  });

  test("an import does not adopt an unbound project when there are two connections", async () => {
    const o = await org();
    await createProject(t.db, { organizationId: o.id, name: "legacy", gitlabProjectId: 42 });
    const [a] = [await connect(o.id), await connect(o.id)];
    // Which instance the old project came from is unknown, so this is a new project, here a name clash.
    const e = await imp(o.id, a.id, { name: "legacy" }).catch((x) => x);
    expect(pgConstraint(e)).toBe("projects_org_name_key");
    const { project, created } = await imp(o.id, a.id, { name: "other" });
    expect([created, project.connectionId]).toEqual([true, a.id]);
  });

  test("an import with no connection binds nothing", async () => {
    const o = await org();
    const { project } = await imp(o.id, undefined);
    expect(project.connectionId).toBeNull();
  });
});

describe("a CI token's issuer speaks for some projects", () => {
  const url = (host: string) => `https://${host}.example`;
  const at = (organizationId: string, host: string, trailing = "") =>
    createConnection(t.db, keys, {
      organizationId,
      type: "gitlab",
      name: `c${++n}`,
      config: { baseUrl: url(host) + trailing },
      token: "glpat-x",
    });
  const idsOf = async (id: number, issuer: string, deployment?: string) =>
    (await projectsOfIssuer(t.db, id, issuer, deployment)).map((p) => p.id);

  test("project 42 of two instances is two projects, and each issuer reaches its own", async () => {
    const [o1, o2] = [await org(), await org()];
    const [a, b] = [await at(o1.id, "a1"), await at(o2.id, "b1")];
    const [pa, pb] = [
      await imp(o1.id, a.id, { gitlabProjectId: 7001 }),
      await imp(o2.id, b.id, { gitlabProjectId: 7001 }),
    ];
    expect(await idsOf(7001, url("a1"))).toEqual([pa.project.id]);
    expect(await idsOf(7001, url("b1"))).toEqual([pb.project.id]);
    // The deployment's own issuer does not reach a project bound to another instance.
    expect(await idsOf(7001, url("a1"), url("b1"))).toEqual([pa.project.id]);
    expect(await idsOf(7001, url("c1"), url("c1"))).toEqual([]);
  });

  test("a connection's address with a trailing slash is the same issuer", async () => {
    const o = await org();
    const c = await at(o.id, "slash", "/");
    const { project } = await imp(o.id, c.id, { gitlabProjectId: 7002 });
    expect(await idsOf(7002, url("slash"))).toEqual([project.id]);
  });

  test("an unbound project is the deployment's and nobody else's, whatever connections its organization has", async () => {
    const o = await org();
    const legacy = await createProject(t.db, {
      organizationId: o.id,
      name: "legacy",
      gitlabProjectId: 7003,
    });
    await at(o.id, "d1");
    expect(await idsOf(7003, url("main"), url("main"))).toEqual([legacy.id]);
    // the organization's only connection does not claim it: that would be a second claimant
    expect(await idsOf(7003, url("d1"), url("main"))).toEqual([]);
    expect(await idsOf(7003, url("main"))).toEqual([]);
  });

  test("a project of a connection of another type is nobody's CI", async () => {
    const o = await org();
    const gh = await createConnection(t.db, keys, {
      organizationId: o.id,
      type: "github",
      name: `c${++n}`,
      config: { baseUrl: url("gh1") },
      token: "ghp-x",
    });
    await imp(o.id, gh.id, { gitlabProjectId: 7004 });
    expect(await idsOf(7004, url("gh1"), url("gh1"))).toEqual([]);
  });

  test("the same project of the same instance in two organizations is still two answers", async () => {
    const [o1, o2] = [await org(), await org()];
    const [a, b] = [await at(o1.id, "same"), await at(o2.id, "same")];
    await imp(o1.id, a.id, { gitlabProjectId: 7005 });
    await imp(o2.id, b.id, { gitlabProjectId: 7005 });
    expect(await idsOf(7005, url("same"))).toHaveLength(2);
  });

  test("an issuer is registered when a GitLab connection has its address", async () => {
    const o = await org();
    const c = await at(o.id, "reg1", "/");
    await createConnection(t.db, keys, {
      organizationId: o.id,
      type: "github",
      name: `c${++n}`,
      config: { baseUrl: url("reg2") },
      token: "ghp-x",
    });
    expect(await connectionsByIssuer(t.db, url("reg1"))).toEqual([
      { id: c.id, baseUrl: `${url("reg1")}/` },
    ]);
    expect(await connectionsByIssuer(t.db, url("reg2"))).toEqual([]);
    expect(await connectionsByIssuer(t.db, url("reg3"))).toEqual([]);
    // a pattern is not a match
    expect(await connectionsByIssuer(t.db, "%")).toEqual([]);
  });
});
