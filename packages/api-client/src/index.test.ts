import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApp } from "@orch/api";
import { createLogger } from "@orch/core";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createClient, problemOf } from "./index";

let t: TestDb;
let api: ReturnType<typeof createClient>;
beforeAll(async () => {
  t = await createTestDb();
  api = createClient(
    createApp({
      logger: createLogger({ write: () => {} }),
      db: t.db,
      principal: () => ({ id: "client-test", kind: "dev" }),
      ready: async () => {},
    }),
  );
});
afterAll(async () => {
  await t.drop();
});

const uniq = () => crypto.randomUUID().slice(0, 8);

test("the client walks the whole organization -> project -> environment tree, typed", async () => {
  const slug = `org-${uniq()}`;
  const org = await api.organizations.post({ slug, name: "Org" });
  expect(org.status).toBe(201);
  if (!org.data) throw new Error("create failed");
  const orgId: string = org.data.id;
  expect(org.data.slug).toBe(slug);

  const project = await api.organizations({ orgId }).projects.post({ name: "app" });
  if (!project.data) throw new Error("create failed");
  expect(project.data.defaultBranch).toBe("main");
  const projectId: string = project.data.id;

  const env = await api
    .organizations({ orgId })
    .projects({ projectId })
    .environments.post({ name: "Production", slug: "prod", sortOrder: 2 });
  expect(env.data?.slug).toBe("prod");

  const list = await api
    .organizations({ orgId })
    .projects({ projectId })
    .environments.get({
      query: { limit: 10 },
    });
  expect(list.data?.items.map((e) => e.slug)).toEqual(["prod"]);
  expect(list.data?.nextCursor).toBeNull();

  const renamed = await api.organizations({ orgId }).patch({ name: "Renamed" });
  expect(renamed.data?.name).toBe("Renamed");

  expect((await api.organizations({ orgId }).delete()).status).toBe(409); // still has a project
});

test("errors come back as typed problems, not thrown", async () => {
  const res = await api.organizations({ orgId: Bun.randomUUIDv7() }).get();
  expect(res.status).toBe(404);
  expect(res.data).toBeNull();
  expect(problemOf(res)).toMatchObject({ status: 404, code: "not_found" });
});

test("what the compiler rejects (each line below must stay a type error)", async () => {
  const never = async () => {
    // @ts-expect-error an unknown field
    await api.organizations.post({ slug: "x", name: "y", colour: "red" });
    // @ts-expect-error a required field is missing
    await api.organizations.post({ slug: "x" });
    // @ts-expect-error not a route
    await api.organisations.get();
    // @ts-expect-error `slug` is immutable
    await api.organizations({ orgId: "x" }).patch({ slug: "new" });
  };
  expect(typeof never).toBe("function"); // compiled, never called
});
