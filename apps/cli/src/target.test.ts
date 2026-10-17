import { describe, expect, test } from "bun:test";
import type { clientFor } from "./api";
import { CliError, type Context } from "./cli";
import { resolveEnvironment } from "./target";

const ctx = { cwd: "/nowhere-with-no-orch-json" } as Context;

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
