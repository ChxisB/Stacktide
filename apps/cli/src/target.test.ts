import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { clientFor } from "./api";
import { CliError, type Context } from "./cli";
import { PROJECT_FILE } from "./project";
import { resolveEnvironment } from "./target";

const ctx = { cwd: "/nowhere-with-no-orch-json", env: {} } as Context;

describe("resolveEnvironment", () => {
  test("a list that never ends is not read for ever, and does not pretend the name is not there", async () => {
    let pages = 0;
    const client = {
      organizations: {
        get: async () => {
          pages++;
          return { data: { items: [], nextCursor: "more" }, error: null, status: 200 };
        },
      },
    } as unknown as ReturnType<typeof clientFor>;
    let error: unknown;
    try {
      await resolveEnvironment(ctx, "http://x", client, { org: "acme", project: "p", env: "e" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe("more than 2000 to look through: pass the id instead");
    expect((error as CliError).exitCode).toBe(2);
    expect(pages).toBe(20);
  });

  test("pages are followed with the cursor the API gave, and a name on a later page is found", async () => {
    const seen: (string | undefined)[] = [];
    const limits: number[] = [];
    const id = crypto.randomUUID();
    const client = {
      organizations: {
        get: async ({ query }: { query: { limit: number; cursor?: string } }) => {
          seen.push(query.cursor);
          limits.push(query.limit);
          return query.cursor === "c1"
            ? {
                data: { items: [{ id, name: "Second", slug: "second" }], nextCursor: null },
                error: null,
                status: 200,
              }
            : {
                data: {
                  items: [{ id: crypto.randomUUID(), name: "First", slug: "first" }],
                  nextCursor: "c1",
                },
                error: null,
                status: 200,
              };
        },
      },
    } as unknown as ReturnType<typeof clientFor>;
    const found = await resolveEnvironment(ctx, "http://x", client, {
      org: "second",
      project: crypto.randomUUID(),
      env: crypto.randomUUID(),
    });
    expect(found.orgId).toBe(id);
    expect(seen).toEqual([undefined, "c1"]);
    // the largest page the API allows: a name is looked up in few requests
    expect(limits).toEqual([100, 100]);
  });
});

describe("resolveEnvironment from ORCH_ORG, ORCH_PROJECT and ORCH_ENV", () => {
  const [org, project, env] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const named = { ORCH_ORG: org, ORCH_PROJECT: project, ORCH_ENV: env };
  // ids are taken as given, so a client that is asked anything fails: a CI token cannot list
  const noLookups = new Proxy(
    {},
    {
      get: () => {
        throw new Error("the API was asked to list");
      },
    },
  ) as unknown as ReturnType<typeof clientFor>;
  const within = (env: Record<string, string | undefined>, cwd = ctx.cwd) =>
    ({ ...ctx, env, cwd }) as Context;
  const refusal = async (c: Context) => {
    try {
      await resolveEnvironment(c, "http://x", noLookups, {});
    } catch (e) {
      return e as CliError;
    }
    throw new Error("expected a refusal");
  };

  test("ids from the environment are used as they are, with no lookup", async () => {
    const found = await resolveEnvironment(within(named), "http://x", noLookups, {});
    expect(found).toMatchObject({ orgId: org, projectId: project, envId: env });
  });

  test("a flag wins over it, one field at a time", async () => {
    const other = crypto.randomUUID();
    const found = await resolveEnvironment(within(named), "http://x", noLookups, { env: other });
    expect(found).toMatchObject({ orgId: org, projectId: project, envId: other });
  });

  test("it wins over .orch.json, which holds names a CI token could not look up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-target-"));
    try {
      await writeFile(
        join(dir, PROJECT_FILE),
        JSON.stringify({ organization: "acme", project: "web", environment: "dev" }),
      );
      const found = await resolveEnvironment(within(named, dir), "http://x", noLookups, {});
      expect(found).toMatchObject({ orgId: org, projectId: project, envId: env });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an empty variable falls through to .orch.json, as an unset one does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-target-"));
    const [fileOrg, fileProject, fileEnv] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    try {
      await writeFile(
        join(dir, PROJECT_FILE),
        JSON.stringify({ organization: fileOrg, project: fileProject, environment: fileEnv }),
      );
      const empty = { ORCH_ORG: "", ORCH_PROJECT: "", ORCH_ENV: "" };
      for (const env of [empty, {}]) {
        const found = await resolveEnvironment(within(env, dir), "http://x", noLookups, {});
        expect(found).toMatchObject({ orgId: fileOrg, projectId: fileProject, envId: fileEnv });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an empty variable is not set, and what is missing is asked for by flag", async () => {
    const error = await refusal(within({ ...named, ORCH_ENV: "" }));
    expect([error.message, error.exitCode]).toEqual([
      "no environment: pass --env, set ORCH_ENV or put it in .orch.json",
      2,
    ]);
    expect((await refusal(within({ ...named, ORCH_ORG: "" }))).message).toBe(
      "no organization: pass --org, set ORCH_ORG or put it in .orch.json",
    );
    expect((await refusal(within({ ...named, ORCH_PROJECT: undefined }))).message).toBe(
      "no project: pass --project, set ORCH_PROJECT or put it in .orch.json",
    );
  });
});
