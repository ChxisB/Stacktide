import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { auditEvents, organizations } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { and, eq } from "drizzle-orm";
import { createApp } from "../app";
import { unauditedRoutes } from "../audit";
import { devPrincipal } from "../principal";

let t: TestDb;
let server: ReturnType<typeof app>;
beforeAll(async () => {
  t = await createTestDb();
  server = app();
});
afterAll(async () => {
  await t.drop();
});

const app = () =>
  createApp({
    logger: createLogger({ write: () => {} }),
    db: t.db,
    principal: devPrincipal,
    ready: async () => {},
  });

// biome-ignore lint/suspicious/noExplicitAny: response bodies are checked by the assertions
type Json = any;
async function call(method: string, path: string, body?: unknown) {
  const res = await server.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, text, json: (text ? JSON.parse(text) : undefined) as Json };
}

const uniq = () => crypto.randomUUID().slice(0, 8);
async function newOrg() {
  const r = await call("POST", "/organizations", { slug: `org-${uniq()}`, name: "Org" });
  expect(r.status).toBe(201);
  return r.json as { id: string; slug: string };
}
async function newProject(orgId: string, name = `p-${uniq()}`, extra: object = {}) {
  const r = await call("POST", `/organizations/${orgId}/projects`, { name, ...extra });
  expect(r.status).toBe(201);
  return r.json as { id: string; name: string };
}
const envPath = (orgId: string, projectId: string) =>
  `/organizations/${orgId}/projects/${projectId}/environments`;
async function newEnv(orgId: string, projectId: string, slug: string, sortOrder?: number) {
  const r = await call("POST", envPath(orgId, projectId), {
    name: slug.toUpperCase(),
    slug,
    sortOrder,
  });
  expect(r.status).toBe(201);
  return r.json as { id: string; slug: string };
}
const auditFor = (action: string, resourceId: string) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.action, action), eq(auditEvents.resourceId, resourceId)));
const auditCount = async () => (await t.db.select().from(auditEvents)).length;

/** Follows `nextCursor` to the end; returns every page. */
async function walk(path: string, limit: number) {
  const pages: Json[][] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const r = await call("GET", `${path}?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
    expect(r.status).toBe(200);
    pages.push(r.json.items);
    cursor = r.json.nextCursor;
    if (!cursor) return pages;
  }
  throw new Error("pagination did not end");
}

describe("organizations", () => {
  test("create answers 201 and writes one audit row with the caller", async () => {
    const slug = `acme-${uniq()}`;
    const r = await call("POST", "/organizations", { slug, name: "  Acme  " });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ slug, name: "Acme" });
    expect(new Date(r.json.createdAt).toISOString()).toBe(r.json.createdAt);
    const rows = await auditFor("organization.create", r.json.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorKind: "dev",
      actorId: "dev",
      resourceType: "organization",
      organizationId: r.json.id,
      metadata: { slug, name: "Acme" },
    });
    expect((await call("GET", `/organizations/${r.json.id}`)).json).toEqual(r.json);
  });

  test("a taken slug is a 409 problem that names no constraint, and writes no audit row", async () => {
    const org = await newOrg();
    const before = await auditCount();
    const r = await call("POST", "/organizations", { slug: org.slug, name: "Again" });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: "slug_taken", status: 409 });
    expect(r.text).not.toMatch(/_key|constraint|violates|SQL/i);
    expect(await auditCount()).toBe(before);
  });

  test("an organization can be created linked to a GitLab group, once, and never relinked", async () => {
    const group = 6_000_000_000 + Math.floor(Math.random() * 1e6);
    const r = await call("POST", "/organizations", {
      slug: `l-${uniq()}`,
      name: "L",
      gitlabGroupId: group,
    });
    expect(r.status).toBe(201);
    expect(r.json.gitlabGroupId).toBe(group);
    expect((await call("GET", `/organizations/${r.json.id}`)).json.gitlabGroupId).toBe(group);
    expect((await auditFor("organization.create", r.json.id))[0]?.metadata).toMatchObject({
      gitlabGroupId: group,
    });
    const plain = await call("POST", "/organizations", { slug: `p-${uniq()}`, name: "P" });
    expect(plain.json.gitlabGroupId).toBeNull();
    // A group belongs to one organization.
    const before = await auditCount();
    const again = await call("POST", "/organizations", {
      slug: `l-${uniq()}`,
      name: "M",
      gitlabGroupId: group,
    });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("gitlab_group_linked");
    expect(again.text).not.toMatch(/_key|constraint|violates|SQL/i);
    expect(await auditCount()).toBe(before);
    // Fixed at creation: an update cannot move it.
    for (const patch of [
      { gitlabGroupId: group + 1 },
      { gitlabGroupId: null },
      { name: "x", gitlabGroupId: 5 },
    ]) {
      expect((await call("PATCH", `/organizations/${r.json.id}`, patch)).status).toBe(422);
    }
    expect((await call("GET", `/organizations/${r.json.id}`)).json.gitlabGroupId).toBe(group);
    for (const bad of [0, -1, 1.5, "5", null, Number.MAX_SAFE_INTEGER + 2]) {
      const res = await call("POST", "/organizations", {
        slug: `l-${uniq()}`,
        name: "x",
        gitlabGroupId: bad,
      });
      expect([bad, res.status]).toEqual([bad, 422]);
    }
  });

  test("bad input is a 422 that lists paths and rules, never the submitted value", async () => {
    const canary = "Canary_VALUE-77";
    for (const body of [
      { slug: canary, name: "x" }, // upper case and underscore
      { slug: "ok", name: "   " },
      { slug: "ok" },
      { slug: "ok", name: "x", role: "admin" }, // unknown field
      { slug: "a--b", name: "x" },
      { slug: "x".repeat(64), name: "x" },
    ]) {
      const r = await call("POST", "/organizations", body);
      expect(r.status).toBe(422);
      expect(r.json.code).toBe("validation_failed");
      expect(r.text).not.toContain(canary);
    }
    expect((await call("POST", "/organizations", "{not json")).status).toBe(400);
    expect((await call("POST", "/organizations", [])).status).toBe(422);
  });

  test("get: unknown id is 404, a malformed id is 422", async () => {
    expect((await call("GET", `/organizations/${Bun.randomUUIDv7()}`)).json.code).toBe("not_found");
    expect((await call("GET", "/organizations/not-a-uuid")).status).toBe(422);
  });

  test("update renames, keeps the slug, and audits which fields changed, not their values", async () => {
    const org = await newOrg();
    const r = await call("PATCH", `/organizations/${org.id}`, { name: "Renamed" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: "Renamed", slug: org.slug });
    const [row] = await auditFor("organization.update", org.id);
    expect(row?.metadata).toEqual({ slug: org.slug, fields: ["name"] });
    // nothing to change, or the slug (an identifier), is refused
    expect((await call("PATCH", `/organizations/${org.id}`, {})).status).toBe(422);
    expect((await call("PATCH", `/organizations/${org.id}`, { slug: "new" })).status).toBe(422);
    const before = await auditCount();
    expect(
      (await call("PATCH", `/organizations/${Bun.randomUUIDv7()}`, { name: "x" })).status,
    ).toBe(404);
    expect(await auditCount()).toBe(before);
  });

  test("delete: 409 while projects exist, 204 when empty; the audit row outlives the organization", async () => {
    const org = await newOrg();
    const project = await newProject(org.id);
    const before = await auditCount();
    const blocked = await call("DELETE", `/organizations/${org.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe("organization_not_empty");
    expect(await auditCount()).toBe(before);
    expect((await call("GET", `/organizations/${org.id}`)).status).toBe(200);

    await call("DELETE", `/organizations/${org.id}/projects/${project.id}`);
    const gone = await call("DELETE", `/organizations/${org.id}`);
    expect(gone.status).toBe(204);
    expect(gone.text).toBe("");
    expect((await call("GET", `/organizations/${org.id}`)).status).toBe(404);
    expect(await auditFor("organization.delete", org.id)).toHaveLength(1);
    expect((await call("DELETE", `/organizations/${org.id}`)).status).toBe(404);
  });

  test("the list pages by id without skipping or repeating", async () => {
    const made = [await newOrg(), await newOrg(), await newOrg()];
    const ids = (await walk("/organizations", 2)).flat().map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());
    for (const o of made) expect(ids).toContain(o.id);
  });
});

describe("pagination edges", () => {
  test("an empty list is an empty page, an exact fit has no next page, extra rows do", async () => {
    const org = await newOrg();
    const empty = await call("GET", `/organizations/${org.id}/projects`);
    expect(empty.json).toEqual({ items: [], nextCursor: null });

    for (let i = 0; i < 5; i++) await newProject(org.id, `p${i}`);
    const path = `/organizations/${org.id}/projects`;
    const exact = await call("GET", `${path}?limit=5`);
    expect(exact.json.items).toHaveLength(5);
    expect(exact.json.nextCursor).toBeNull();
    const four = await call("GET", `${path}?limit=4`);
    expect(four.json.items).toHaveLength(4);
    expect(four.json.nextCursor).toBeString();

    const pages = await walk(path, 2);
    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat().map((p) => p.name)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect((await call("GET", path)).json.items).toHaveLength(5); // default limit
  });

  test("limit is bounded and numeric; the cursor must be one we issued for this list", async () => {
    const org = await newOrg();
    const project = await newProject(org.id);
    await newEnv(org.id, project.id, "dev");
    await newEnv(org.id, project.id, "prod");
    const path = `/organizations/${org.id}/projects`;
    for (const limit of ["0", "-1", "101", "abc", "1.5", ""]) {
      expect((await call("GET", `${path}?limit=${limit}`)).status).toBe(422);
    }
    expect((await call("GET", `${path}?limit=100`)).status).toBe(200);

    const envCursor = (await call("GET", `${envPath(org.id, project.id)}?limit=1`)).json.nextCursor;
    expect(envCursor).toBeString();
    for (const cursor of ["garbage", "e30", btoa("[1]"), envCursor, "A".repeat(301)]) {
      const r = await call("GET", `${path}?cursor=${encodeURIComponent(cursor)}`);
      expect(r.status).toBe(cursor.length > 300 ? 422 : 400);
    }
    expect((await call("GET", `${path}?cursor=garbage`)).json.code).toBe("invalid_cursor");
  });

  test("a well-formed cursor with out-of-range parts is a 400, not a database error", async () => {
    const org = await newOrg();
    const project = await newProject(org.id);
    const forge = (key: unknown[]) => Buffer.from(JSON.stringify(key)).toString("base64url");
    for (const key of [
      [99_999_999_999, "a"],
      [-1, "a"],
      [0, "a\u0000"],
      [0, "Not A Slug"],
      [0, "a", 1],
    ]) {
      const r = await call("GET", `${envPath(org.id, project.id)}?cursor=${forge(key)}`);
      expect([r.status, r.json.code]).toEqual([400, "invalid_cursor"]);
    }
    // uuid parts too: a non-uuid would reach the uuid column
    const r = await call("GET", `/organizations/${org.id}/projects?cursor=${forge(["nope"])}`);
    expect(r.status).toBe(400);
  });
});

describe("projects", () => {
  test("create applies defaults, links a GitLab project, and audits", async () => {
    const org = await newOrg();
    const plain = await newProject(org.id, "plain");
    expect(plain).toMatchObject({
      gitlabProjectId: null,
      defaultBranch: "main",
      organizationId: org.id,
    });
    const linked = await newProject(org.id, "linked", {
      gitlabProjectId: 42,
      defaultBranch: "trunk",
    });
    expect(linked).toMatchObject({ gitlabProjectId: 42, defaultBranch: "trunk" });
    const [row] = await auditFor("project.create", linked.id);
    expect(row).toMatchObject({
      resourceType: "project",
      organizationId: org.id,
      projectId: linked.id,
      metadata: { name: "linked" },
    });
  });

  test("conflicts: a name is unique per organization, a GitLab project links once", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    await newProject(a.id, "api", { gitlabProjectId: 7 });
    const path = `/organizations/${a.id}/projects`;
    expect((await call("POST", path, { name: "api" })).json.code).toBe("name_taken");
    expect((await call("POST", path, { name: "other", gitlabProjectId: 7 })).json.code).toBe(
      "gitlab_project_linked",
    );
    await newProject(b.id, "api", { gitlabProjectId: 7 }); // another organization is a separate scope
    const other = await newProject(a.id, "web");
    const clash = await call("PATCH", `${path}/${other.id}`, { name: "api" });
    expect(clash.status).toBe(409);
    expect(clash.text).not.toMatch(/_key|constraint|violates/i);
  });

  test("bad input is a 422", async () => {
    const org = await newOrg();
    const path = `/organizations/${org.id}/projects`;
    for (const body of [
      {},
      { name: "" },
      { name: "x", gitlabProjectId: 0 },
      { name: "x", gitlabProjectId: -3 },
      { name: "x", gitlabProjectId: 1.5 },
      { name: "x", gitlabProjectId: "7" },
      { name: "x", defaultBranch: "a..b" },
      { name: "x", defaultBranch: "-rf" },
      { name: "x", defaultBranch: "" },
      { name: "x", defaultBranch: "has space" },
      { name: "x", organizationId: Bun.randomUUIDv7() }, // the organization comes from the path
    ]) {
      expect((await call("POST", path, body)).status).toBe(422);
    }
  });

  test("a project in a missing organization is a 404 and leaves no audit row", async () => {
    const before = await auditCount();
    const r = await call("POST", `/organizations/${Bun.randomUUIDv7()}/projects`, { name: "x" });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe("not_found");
    expect((await call("GET", `/organizations/${Bun.randomUUIDv7()}/projects`)).status).toBe(404);
    expect(await auditCount()).toBe(before);
  });

  test("update changes the given fields, null unlinks GitLab, and audits the field names", async () => {
    const org = await newOrg();
    const p = await newProject(org.id, "old", { gitlabProjectId: 9 });
    const path = `/organizations/${org.id}/projects/${p.id}`;
    const r = await call("PATCH", path, {
      name: "new",
      gitlabProjectId: null,
      defaultBranch: "dev",
    });
    expect(r.json).toMatchObject({ name: "new", gitlabProjectId: null, defaultBranch: "dev" });
    const [row] = await auditFor("project.update", p.id);
    expect(row?.metadata).toEqual({ fields: ["name", "gitlabProjectId", "defaultBranch"] });
    expect((await call("PATCH", path, {})).status).toBe(422);
    expect((await call("PATCH", path, { id: Bun.randomUUIDv7() })).status).toBe(422);
  });

  test("another organization cannot read, change or delete a project", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    const p = await newProject(a.id);
    const before = await auditCount();
    const wrong = `/organizations/${b.id}/projects/${p.id}`;
    expect((await call("GET", wrong)).status).toBe(404);
    expect((await call("PATCH", wrong, { name: "x" })).status).toBe(404);
    expect((await call("DELETE", wrong)).status).toBe(404);
    expect(await auditCount()).toBe(before);
    expect((await call("GET", `/organizations/${a.id}/projects/${p.id}`)).json.id).toBe(p.id);
    expect((await call("GET", `/organizations/${b.id}/projects`)).json.items).toEqual([]);
  });

  test("delete takes the environments with it, and audits", async () => {
    const org = await newOrg();
    const p = await newProject(org.id, "doomed");
    const env = await newEnv(org.id, p.id, "prod");
    const gone = await call("DELETE", `/organizations/${org.id}/projects/${p.id}`);
    expect(gone.status).toBe(204);
    expect((await call("GET", `/organizations/${org.id}/projects/${p.id}`)).status).toBe(404);
    expect((await call("GET", `${envPath(org.id, p.id)}/${env.id}`)).status).toBe(404);
    const [row] = await auditFor("project.delete", p.id);
    expect(row?.metadata).toEqual({ name: "doomed" });
  });
});

describe("environments", () => {
  test("list orders by sortOrder then slug and pages through ties", async () => {
    const org = await newOrg();
    const p = await newProject(org.id);
    for (const [slug, order] of [
      ["b", 1],
      ["a", 1],
      ["z", 0],
      ["c", 1],
      ["y", 2],
    ] as const) {
      await newEnv(org.id, p.id, slug, order);
    }
    const pages = await walk(envPath(org.id, p.id), 2);
    expect(pages.flat().map((e) => e.slug)).toEqual(["z", "a", "b", "c", "y"]);
    expect(pages.map((x) => x.length)).toEqual([2, 2, 1]);
  });

  test("create, read, update (slug is fixed), delete, each audited", async () => {
    const org = await newOrg();
    const p = await newProject(org.id);
    const env = await newEnv(org.id, p.id, "staging");
    const path = `${envPath(org.id, p.id)}/${env.id}`;
    expect((await call("GET", path)).json).toMatchObject({
      slug: "staging",
      sortOrder: 0,
      projectId: p.id,
    });
    const r = await call("PATCH", path, { name: "Stage", sortOrder: 5 });
    expect(r.json).toMatchObject({ name: "Stage", sortOrder: 5, slug: "staging" });
    expect((await call("PATCH", path, { slug: "other" })).status).toBe(422);
    expect((await call("PATCH", path, {})).status).toBe(422);
    expect((await call("DELETE", path)).status).toBe(204);
    expect((await call("GET", path)).status).toBe(404);
    expect((await call("DELETE", path)).status).toBe(404);
    for (const action of ["create", "update", "delete"]) {
      const [row] = await auditFor(`environment.${action}`, env.id);
      expect(row).toMatchObject({
        resourceType: "environment",
        organizationId: org.id,
        projectId: p.id,
      });
      expect(row?.metadata).toMatchObject({ slug: "staging" });
    }
  });

  test("conflicts and missing parents", async () => {
    const [a, b] = [await newOrg(), await newOrg()];
    const p = await newProject(a.id);
    const foreign = await newProject(b.id);
    await newEnv(a.id, p.id, "prod");
    const path = envPath(a.id, p.id);
    expect((await call("POST", path, { name: "Prod", slug: "prod" })).json.code).toBe("slug_taken");
    // the same slug under another project is fine
    const sibling = await newProject(a.id);
    await newEnv(a.id, sibling.id, "prod");

    const before = await auditCount();
    expect(
      (await call("POST", envPath(a.id, Bun.randomUUIDv7()), { name: "x", slug: "x" })).status,
    ).toBe(404);
    // a project of another organization, reached through this organization's path
    expect((await call("POST", envPath(a.id, foreign.id), { name: "x", slug: "x" })).status).toBe(
      404,
    );
    expect((await call("GET", envPath(a.id, foreign.id))).status).toBe(404);
    expect(await auditCount()).toBe(before);
  });

  test("bad input is a 422", async () => {
    const org = await newOrg();
    const p = await newProject(org.id);
    for (const body of [
      {},
      { name: "x" },
      { name: "x", slug: "Prod" },
      { name: "x", slug: "ok", sortOrder: -1 },
      { name: "x", slug: "ok", sortOrder: 1.5 },
      { name: "x", slug: "ok", projectId: Bun.randomUUIDv7() },
    ]) {
      expect((await call("POST", envPath(org.id, p.id), body)).status).toBe(422);
    }
  });
});

describe("paths", () => {
  test("collections answer with and without a trailing slash", async () => {
    expect((await call("GET", "/organizations/")).status).toBe(200);
    expect((await call("GET", "/organizations")).status).toBe(200);
  });
});

describe("request bodies", () => {
  test("any case of application/json is accepted", async () => {
    const res = await server.handle(
      new Request("http://localhost/organizations", {
        method: "POST",
        headers: { "content-type": "Application/JSON" },
        body: JSON.stringify({ slug: `up-${uniq()}`, name: "Upper" }),
      }),
    );
    expect(res.status).toBe(201);
  });

  // A cross-site form can send text/plain or urlencoded without a CORS preflight: only a real
  // application/json request may change anything.
  test("a body that is not declared JSON is refused on every writing route, and changes nothing", async () => {
    const org = await newOrg();
    const p = await newProject(org.id);
    const e = await newEnv(org.id, p.id, "e1");
    const slug = `csrf-${Bun.randomUUIDv7().slice(-8)}`;
    const routes = [
      ["POST", "/organizations", { slug, name: "X" }],
      ["PATCH", `/organizations/${org.id}`, { name: "changed" }],
      ["POST", `/organizations/${org.id}/projects`, { name: "csrf" }],
      ["PATCH", `/organizations/${org.id}/projects/${p.id}`, { name: "changed" }],
      ["POST", envPath(org.id, p.id), { name: "csrf", slug: "csrf" }],
      ["PATCH", `${envPath(org.id, p.id)}/${e.id}`, { name: "changed" }],
    ] as const;
    for (const [method, path, body] of routes) {
      for (const [type, text] of [
        ["text/plain", JSON.stringify(body)],
        ["application/x-www-form-urlencoded", new URLSearchParams(body).toString()],
      ] as const) {
        const res = await server.handle(
          new Request(`http://localhost${path}`, {
            method,
            headers: { "content-type": type },
            body: text,
          }),
        );
        expect([method, path, type, res.status]).toEqual([method, path, type, 415]);
      }
    }
    expect((await call("GET", `/organizations/${org.id}`)).json.name).toBe("Org");
    expect((await call("GET", `/organizations/${org.id}/projects/${p.id}`)).json.name).toBe(p.name);
    expect((await call("GET", `${envPath(org.id, p.id)}/${e.id}`)).json.name).toBe("E1");
    expect((await call("GET", `/organizations/${org.id}/projects`)).json.items).toHaveLength(1);
    expect((await call("GET", envPath(org.id, p.id))).json.items).toHaveLength(1);
    expect(await t.db.select().from(organizations).where(eq(organizations.slug, slug))).toEqual([]);
  });
});

describe("audit coverage", () => {
  test("every mutating route of the real app declares its audit action", () => {
    expect(unauditedRoutes(app())).toEqual([]);
    const declared = app()
      .routes.flatMap((r) => (r.hooks as { detail?: Record<string, unknown> }).detail?.["x-audit"])
      .filter(Boolean)
      .sort();
    expect(declared).toEqual(
      [
        "auth.ci_exchange",
        "auth.login",
        "auth.logout",
        "token.create",
        "token.revoke",
        "token.create", // the CLI's browser sign-in
        "token.revoke", // the CLI signing itself out
        "connection.create",
        "connection.test",
        "connection.delete",
        "connection.webhook_secret",
        "project.import",
        "sync_run.plan",
        "sync_run.apply",
        "sync_run.failed",
        "pipeline.apply",
        "pipeline.upgrade",
        "pipeline.apply", // the same row, written for each project of an upgrade
        "pipeline.retry",
        "run.create", // a run of IaC stacks
        "run.summary", // a plan job's counts for its stack
        // the environment's resolved set with its values: a row for each secret revealed, and one for the request
        "variable.reveal",
        "variable.export",
        ...["organization", "project", "environment", "sync_target"].flatMap((r) =>
          ["create", "update", "delete"].map((v) => `${r}.${v}`),
        ),
        // At each of the three levels of variables (the action names do not say which level):
        ...["organization", "project", "environment"].flatMap(() => [
          ...["create", "update", "delete", "reveal"].map((v) => `variable.${v}`),
          "variable.update", // putting one variable back to an earlier version
          // putting the whole level back to an earlier moment
          ...["create", "update", "delete", "restore_level"].map((v) => `variable.${v}`),
          // bringing in a file or a GitLab project's variables (the per-change rows reuse create and update)
          "variable.create",
          "variable.update",
          "variable.import",
          // many changes at once (the per-change rows reuse create, update and delete)
          ...["create", "update", "delete", "bulk"].map((v) => `variable.${v}`),
        ]),
      ].sort(),
    );
  });
});
