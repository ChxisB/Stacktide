import { describe, expect, test } from "bun:test";
import { createLogger, type Subject } from "@orch/core";
import { Elysia } from "elysia";
import { z } from "zod";
import { guardPlugin, unguardedRoutes } from "./guard";
import { http } from "./http";
import { devPrincipal, type Principal, principalPlugin } from "./principal";

const ORG = crypto.randomUUID();
const OTHER_ORG = crypto.randomUUID();
const PROJECT = crypto.randomUUID();

const holder = (kind: Subject["kind"], over: Partial<Subject> = {}): Principal => ({
  id: "holder",
  kind,
  subject: { kind, orgRoles: {}, projectRoles: {}, ...over },
});
const orgRole = (role: "viewer" | "member" | "admin" | "owner") =>
  holder("user", { orgRoles: { [ORG]: role } });

const who: Record<string, Principal | undefined> = {
  anonymous: undefined,
  dev: { id: "dev", kind: "dev" },
  stranger: holder("user"),
  "other org owner": holder("user", { orgRoles: { [OTHER_ORG]: "owner" } }),
  viewer: orgRole("viewer"),
  admin: orgRole("admin"),
  owner: orgRole("owner"),
  "platform admin": holder("user", { platformAdmin: true }),
  "project reporter": holder("user", { projectRoles: { [PROJECT]: "reporter" } }),
  // A token whose owner could do everything in ORG, but whose scopes allow less.
  "read-only token": holder("token", {
    orgRoles: { [ORG]: "owner" },
    scopes: ["organization.read"],
  }),
  "project-only token": holder("token", { orgRoles: { [ORG]: "owner" }, scopes: ["project.read"] }),
  "token without scopes": holder("token", { orgRoles: { [ORG]: "owner" } }),
};

const app = new Elysia()
  .use(http(createLogger({ write: () => {} })))
  .use(principalPlugin((request) => who[request.headers.get("x-who") ?? "anonymous"]))
  .use(guardPlugin)
  .get("/open", () => "open", { public: "test route" })
  .get("/mine", () => "mine", { signedIn: "test route" })
  .post("/orgs", () => "created", { guard: "organization.create", parse: "json" })
  .get("/orgs/:orgId", () => "org", { guard: "organization.read" })
  .patch("/orgs/:orgId", () => "patched", {
    guard: "organization.update",
    body: z.object({ name: z.string() }),
    parse: "json",
  })
  .get("/orgs/:orgId/projects/:projectId", () => "project", { guard: "project.read" })
  .delete("/orgs/:orgId/projects/:projectId", () => "gone", { guard: "project.delete" });

async function call(as: string, method: string, path: string, given?: unknown) {
  // The body is parsed before the caller is checked (Elysia's order): writes send an empty object.
  const body = given === undefined && ["POST", "PATCH"].includes(method) ? {} : given;
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "x-who": as,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  const json = res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : undefined;
  return { status: res.status, text, code: json?.code as string | undefined, json };
}

const org = `/orgs/${ORG}`;
const project = `${org}/projects/${PROJECT}`;
const answers = async (who: string, method: string, path: string, body?: unknown) => {
  const r = await call(who, method, path, body);
  return [r.status, r.code ?? r.text];
};

describe("who gets in", () => {
  test("a public route needs no one", async () => {
    expect(await answers("anonymous", "GET", "/open")).toEqual([200, "open"]);
  });

  test("signed-in routes and guarded routes answer an anonymous caller with 401", async () => {
    for (const [method, path] of [
      ["GET", "/mine"],
      ["POST", "/orgs"],
      ["GET", org],
      ["PATCH", org],
      ["GET", project],
      ["DELETE", project],
    ] as const) {
      expect([method, path, await answers("anonymous", method, path)]).toEqual([
        method,
        path,
        [401, "unauthenticated"],
      ]);
    }
    expect(await answers("stranger", "GET", "/mine")).toEqual([200, "mine"]);
  });

  test("a role grants exactly what the model says", async () => {
    expect(await answers("viewer", "GET", org)).toEqual([200, "org"]);
    expect(await answers("viewer", "GET", project)).toEqual([200, "project"]); // viewer -> reporter
    expect(await answers("admin", "PATCH", org, { name: "x" })).toEqual([200, "patched"]);
    expect(await answers("admin", "DELETE", project)).toEqual([200, "gone"]);
    expect(await answers("project reporter", "GET", project)).toEqual([200, "project"]);
  });

  test("the dev principal may do everything", async () => {
    expect(await answers("dev", "POST", "/orgs")).toEqual([200, "created"]);
    expect(await answers("dev", "DELETE", project)).toEqual([200, "gone"]);
  });
});

describe("403 or 404", () => {
  test("whoever cannot read the target gets 404, whether or not it exists", async () => {
    const elsewhere = `/orgs/${crypto.randomUUID()}`;
    for (const who of ["stranger", "other org owner", "project reporter"]) {
      for (const [method, path] of [
        ["GET", org],
        ["PATCH", org],
        ["GET", elsewhere],
        ["PATCH", elsewhere],
      ] as const) {
        expect([who, method, await answers(who, method, path, { name: "x" })]).toEqual([
          who,
          method,
          [404, "not_found"],
        ]);
      }
    }
    // The same answer, word for word, for what exists and what does not.
    const [a, b] = [await call("stranger", "GET", org), await call("stranger", "GET", elsewhere)];
    expect(a.json.detail).toBe(b.json.detail);
  });

  test("a role in another org gives nothing here", async () => {
    expect(await answers("other org owner", "GET", project)).toEqual([404, "not_found"]);
    expect(await answers("other org owner", "DELETE", project)).toEqual([404, "not_found"]);
  });

  test("whoever can read the target but not do this gets 403", async () => {
    expect(await answers("viewer", "PATCH", org, { name: "x" })).toEqual([403, "forbidden"]);
    expect(await answers("viewer", "DELETE", project)).toEqual([403, "forbidden"]);
    expect(await answers("admin", "GET", `${org}/projects/${crypto.randomUUID()}`)).toEqual([
      200,
      "project",
    ]);
    // A project reporter can read the project, not delete it.
    expect(await answers("project reporter", "DELETE", project)).toEqual([403, "forbidden"]);
  });

  test("creating an organization has nothing to hide: 403", async () => {
    for (const who of ["stranger", "viewer", "owner", "other org owner"]) {
      expect([who, await answers(who, "POST", "/orgs")]).toEqual([who, [403, "forbidden"]]);
    }
    expect(await answers("platform admin", "POST", "/orgs")).toEqual([200, "created"]);
  });

  test("the 403 names the action, the 404 names nothing about the target", async () => {
    const forbidden = await call("viewer", "PATCH", org, { name: "x" });
    expect(forbidden.json.detail).toContain("organization.update");
    const hidden = await call("stranger", "PATCH", org, { name: "x" });
    expect(hidden.text).not.toContain(ORG);
    expect(hidden.text).not.toContain("organization.update");
  });
});

describe("scopes", () => {
  test("a token does only what its scopes and its owner's roles both allow", async () => {
    expect(await answers("read-only token", "GET", org)).toEqual([200, "org"]);
    expect(await answers("read-only token", "PATCH", org, { name: "x" })).toEqual([
      403,
      "forbidden",
    ]);
    expect(await answers("project-only token", "GET", project)).toEqual([200, "project"]);
  });

  test("what a scope cannot read does not exist for the token", async () => {
    expect(await answers("project-only token", "GET", org)).toEqual([404, "not_found"]);
    expect(await answers("project-only token", "PATCH", org, { name: "x" })).toEqual([
      404,
      "not_found",
    ]);
  });

  test("a token without scopes can do nothing", async () => {
    expect(await answers("token without scopes", "GET", org)).toEqual([404, "not_found"]);
    expect(await answers("token without scopes", "POST", "/orgs")).toEqual([403, "forbidden"]);
  });
});

describe("order of checks", () => {
  test("the caller is checked before the body, so a bad body tells a stranger nothing", async () => {
    expect(await answers("anonymous", "PATCH", org, {})).toEqual([401, "unauthenticated"]);
    expect(await answers("stranger", "PATCH", org, {})).toEqual([404, "not_found"]);
    expect(await answers("viewer", "PATCH", org, {})).toEqual([403, "forbidden"]);
    expect(await answers("admin", "PATCH", org, {})).toEqual([422, "validation_failed"]);
  });
});

describe("declarations", () => {
  const fresh = () => new Elysia().use(guardPlugin);

  test("an unknown action is refused when the route is declared", () => {
    expect(() => fresh().get("/x", () => 1, { guard: "organization.reed" })).toThrow(TypeError);
    expect(() => fresh().get("/x", () => 1, { guard: "" })).toThrow(TypeError);
  });

  test("public and signedIn need a reason", () => {
    expect(() => fresh().get("/x", () => 1, { public: " " })).toThrow(TypeError);
    expect(() => fresh().get("/x", () => 1, { signedIn: "" })).toThrow(TypeError);
  });

  test("they show up in OpenAPI as x-guard, x-signed-in and x-public", () => {
    const detail = (path: string, method = "GET") => {
      const hooks = app.routes.find((r) => r.path === path && r.method === method)?.hooks as {
        detail?: object;
      };
      return hooks?.detail;
    };
    expect(detail("/open")).toEqual({ "x-public": "test route" });
    expect(detail("/mine")).toEqual({ "x-signed-in": "test route" });
    expect(detail("/orgs/:orgId")).toEqual({ "x-guard": "organization.read" });
  });

  test("a route with none of the three is found, of any method, also inside plugins", () => {
    expect(unguardedRoutes(app)).toEqual([]);
    const bad = new Elysia()
      .use(guardPlugin)
      .get("/read", () => 1)
      .post("/write", () => 1)
      .use(new Elysia().delete("/in-plugin", () => 1))
      .get("/fine", () => 1, { public: "ok" });
    expect(unguardedRoutes(bad).sort()).toEqual(["DELETE /in-plugin", "GET /read", "POST /write"]);
  });

  test("an allowlisted route is skipped, and only that exact one", () => {
    const bad = new Elysia().get("/docs", () => 1).post("/docs", () => 1);
    expect(unguardedRoutes(bad, ["GET /docs"])).toEqual(["POST /docs"]);
  });

  test("the dev principal is a principal, not an anonymous caller", async () => {
    expect(await devPrincipal(new Request("http://localhost/"))).toEqual({
      id: "dev",
      kind: "dev",
    });
  });
});
