import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { actionsApi, createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { runAdapterConformance } from "./conformance";
import { SyncError, type SyncErrorKind } from "./errors";
import { GITHUB_ACTIONS, githubActionsAdapter, parseGithubActionsConfig } from "./github-actions";
import { type LastApplied, plan } from "./plan";
import { refId } from "./ref";
import { ALL_SCOPES, type ItemInput } from "./types";

// FRG-20: GitHub Actions secrets and variables as a sync target. A variable is plain and compared by value; a secret is
// write-only, so it is compared by the time GitHub says it changed.

const CANARY = "actions-canary-6c2d71e0";
const TOKEN = "ghp_not-a-real-token-1234";

const item = (
  key: string,
  value: string,
  secret = false,
  file = false,
  scope = ALL_SCOPES,
): ItemInput => ({
  key,
  scope,
  value,
  secret,
  file,
});

type Where = "repository" | "environment" | "organization";
const CONFIGS: Record<Where, object> = {
  repository: { repository: "acme/svc" },
  environment: { repository: "acme/svc", environment: "prod" },
  organization: { organization: "acme" },
};

function target(where: Where, opts: { maxPerPage?: number; config?: object } = {}) {
  const mock = createMockGithub({ maxPerPage: opts.maxPerPage });
  mock.addOrg("acme");
  mock.addRepo("acme", "svc");
  mock.addEnvironment("acme", "svc", "prod", []);
  const client = createGithubClient({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    token: TOKEN,
    maxRetries: 0,
  });
  const adapter = githubActionsAdapter(actionsApi(client));
  const config = opts.config ?? CONFIGS[where];
  const remote = adapter.connect(adapter.validate(config));
  const held = () =>
    mock.actions(
      where === "organization"
        ? { organization: "acme" }
        : { repository: "acme/svc", ...(where === "environment" ? { environment: "prod" } : {}) },
    );
  return { mock, adapter, config, remote, held, stop: mock.stop };
}

const refused: { item: ItemInput; kind: SyncErrorKind }[] = [
  { item: item("lower", CANARY), kind: "invalid" },
  { item: item("MixedCase", CANARY), kind: "invalid" },
  { item: item("NOT-A-NAME", CANARY), kind: "invalid" },
  { item: item("1ST", CANARY), kind: "invalid" },
  { item: item("HAS SPACE", CANARY), kind: "invalid" },
  { item: item("GITHUB_TOKEN", CANARY), kind: "invalid" },
  { item: item("BIG", "x".repeat(48 * 1024 + 1)), kind: "invalid" },
  { item: item("BIG_SECRET", "x".repeat(48 * 1024 + 1), true), kind: "invalid" },
  { item: item("FILE", CANARY, false, true), kind: "unsupported" },
  { item: item("FILE_SECRET", CANARY, true, true), kind: "unsupported" },
];

for (const where of Object.keys(CONFIGS) as Where[]) {
  runAdapterConformance(
    `github actions, ${where}`,
    async () => {
      const t = target(where);
      return { adapter: t.adapter, config: t.config, stop: t.stop };
    },
    { refused, capitalKeys: true },
  );
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    return e as SyncError;
  }
  throw new Error("expected a SyncError");
}

describe("github actions config", () => {
  test("is a repository, one of its environments, or an organization", () => {
    for (const ok of [
      { repository: "acme/svc" },
      { repository: "acme/svc", protected: true },
      { repository: "acme/svc", environment: "prod", protected: false },
      { repository: "my-org/my.repo_1" },
      { organization: "acme" },
      { organization: "acme", visibility: "all", protected: true },
      { organization: "acme", visibility: "private" },
    ]) {
      expect(parseGithubActionsConfig(ok) as unknown).toEqual(ok);
    }
  });

  test.each([
    ["nothing to say whose", {}],
    ["a repository and an organization", { repository: "a/b", organization: "a" }],
    ["a repository that is not owner/name", { repository: "svc" }],
    ["a repository with three parts", { repository: "a/b/c" }],
    ["a repository that walks up", { repository: "a/.." }],
    ["a repository with a space", { repository: "a/b c" }],
    ["an environment without a repository", { environment: "prod" }],
    ["an empty environment", { repository: "a/b", environment: "" }],
    ["an environment with a slash", { repository: "a/b", environment: "x/y" }],
    ["an environment that walks up", { repository: "a/b", environment: ".." }],
    ["a visibility on a repository", { repository: "a/b", visibility: "all" }],
    ["a visibility on an environment", { repository: "a/b", environment: "e", visibility: "all" }],
    [
      "a visibility GitHub has but this does not offer",
      { organization: "a", visibility: "selected" },
    ],
    ["an organization with a slash", { organization: "a/b" }],
    ["an empty organization", { organization: "" }],
    ["a token in it", { repository: "a/b", token: CANARY }],
    ["an unknown field", { repository: "a/b", extra: 1 }],
    ["protected that is not a boolean", { repository: "a/b", protected: "yes" }],
    ["a string", CANARY],
    ["null", null],
  ])("refuses %s, and says nothing of what was given", (_, bad) => {
    let error: unknown;
    try {
      parseGithubActionsConfig(bad);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SyncError);
    expect((error as SyncError).kind).toBe("invalid_config");
    expect((error as SyncError).message).not.toContain(CANARY);
  });

  test("the type is github-actions", () => {
    expect(GITHUB_ACTIONS).toBe("github-actions");
    expect(target("repository").adapter.type).toBe("github-actions");
  });
});

describe("what goes where", () => {
  test.each(Object.keys(CONFIGS) as Where[])(
    "a secret is sealed and a plain item is a variable, %s",
    async (where) => {
      const t = target(where);
      await t.remote.create(item("TOKEN", "s3cret value", true));
      await t.remote.create(item("REGION", "eu-west-1"));
      expect(t.held().secrets.TOKEN?.value).toBe("s3cret value");
      expect(t.held().variables.REGION?.value).toBe("eu-west-1");
      expect(Object.keys(t.held().secrets)).toEqual(["TOKEN"]);
      expect(Object.keys(t.held().variables)).toEqual(["REGION"]);
      expect(await t.remote.read()).toEqual([
        { key: "REGION", scope: "*", value: "eu-west-1", secret: false, file: false },
        {
          key: "TOKEN",
          scope: "*",
          value: null,
          secret: true,
          file: false,
          changedAt: t.held().secrets.TOKEN?.updatedAt,
        },
      ]);
    },
  );

  test("an organization's items are for private repositories unless the config says all", async () => {
    const t = target("organization");
    await t.remote.create(item("S", "x", true));
    await t.remote.create(item("V", "x"));
    expect([t.held().secrets.S?.visibility, t.held().variables.V?.visibility]).toEqual([
      "private",
      "private",
    ]);
    const all = target("organization", { config: { organization: "acme", visibility: "all" } });
    await all.remote.create(item("S", "x", true));
    await all.remote.create(item("V", "x"));
    expect([all.held().secrets.S?.visibility, all.held().variables.V?.visibility]).toEqual([
      "all",
      "all",
    ]);
    // a change keeps what the config says, as the PUT that sets a secret resets it
    await all.remote.update(item("S", "y", true));
    await all.remote.update(item("V", "y"));
    expect([all.held().secrets.S?.visibility, all.held().variables.V?.visibility]).toEqual([
      "all",
      "all",
    ]);
  });

  test("a repository's and an environment's items carry no visibility", async () => {
    for (const where of ["repository", "environment"] as const) {
      const t = target(where);
      await t.remote.create(item("S", "x", true));
      await t.remote.create(item("V", "x"));
      expect(t.held().secrets.S).not.toHaveProperty("visibility");
      expect(t.held().variables.V).not.toHaveProperty("visibility");
    }
  });

  test("an environment the repository does not have fails, and names no value", async () => {
    const t = target("environment", {
      config: { repository: "acme/svc", environment: "ghost" },
    });
    const e = await failure(t.remote.read());
    expect(e.kind).toBe("failed");
    expect(e.message).not.toContain(TOKEN);
  });
});

describe("a secret and a variable of one name are one item", () => {
  test("a secret turned plain becomes a variable and the secret is gone", async () => {
    const t = target("repository");
    await t.remote.create(item("K", "secret-one", true));
    await t.remote.update(item("K", "plain-one", false));
    expect(t.held().secrets).toEqual({});
    expect(t.held().variables.K?.value).toBe("plain-one");
    expect((await t.remote.read()).map((i) => [i.key, i.secret, i.value])).toEqual([
      ["K", false, "plain-one"],
    ]);
  });

  test("a variable made secret becomes a secret and the readable value is gone", async () => {
    const t = target("repository");
    await t.remote.create(item("K", "plain-one"));
    await t.remote.update(item("K", "secret-one", true));
    expect(t.held().variables).toEqual({});
    expect(t.held().secrets.K?.value).toBe("secret-one");
  });

  test("the plain value is removed before the secret is written, so a failure cannot leave it", async () => {
    const t = target("repository");
    await t.remote.create(item("K", "plain-one"));
    t.mock.inject({
      method: "PUT",
      path: "/repos/acme/svc/actions/secrets/K",
      status: 500,
      times: 1,
      body: { message: "boom" },
    });
    await failure(t.remote.update(item("K", "secret-one", true)));
    expect(t.held().variables).toEqual({});
  });

  test("a name held both ways reads as the secret, and an update to either kind leaves one", async () => {
    for (const secret of [true, false]) {
      const t = target("repository");
      const api = actionsApi(
        createGithubClient({
          baseUrl: t.mock.url,
          allowInsecureHttp: true,
          token: TOKEN,
          maxRetries: 0,
        }),
      );
      await api.secrets.put({ repository: "acme/svc" }, "TWICE", "hidden");
      await api.variables.create({ repository: "acme/svc" }, "TWICE", "visible");
      expect((await t.remote.read()).map((i) => [i.key, i.secret])).toEqual([["TWICE", true]]);
      await t.remote.update(item("TWICE", "now", secret));
      const { secrets, variables } = t.held();
      expect(Object.keys(secret ? secrets : variables)).toEqual(["TWICE"]);
      expect(Object.keys(secret ? variables : secrets)).toEqual([]);
    }
  });

  test("a create finds a name held by the other kind and refuses it", async () => {
    const t = target("repository");
    await t.remote.create(item("K", "v"));
    expect((await failure(t.remote.create(item("K", CANARY, true)))).kind).toBe("exists");
    expect(t.held().secrets).toEqual({});
  });

  test("a delete removes whichever kind is there, or both, and is not_found for neither", async () => {
    const t = target("repository");
    await t.remote.create(item("A", "1", true));
    await t.remote.create(item("B", "2"));
    await t.remote.delete({ key: "A", scope: "*" });
    await t.remote.delete({ key: "B", scope: "*" });
    expect(await t.remote.read()).toEqual([]);
    expect((await failure(t.remote.delete({ key: "A", scope: "*" }))).kind).toBe("not_found");
  });

  test("a variable made between the look and the write is exists, not a failure", async () => {
    const t = target("repository");
    t.mock.inject({
      method: "POST",
      path: "/repos/acme/svc/actions/variables",
      status: 409,
      times: 1,
      body: { message: "Already exists" },
    });
    expect((await failure(t.remote.create(item("K", "v")))).kind).toBe("exists");
  });

  test("a delete GitHub fails is a failure, not a name that was not there", async () => {
    const t = target("repository");
    await t.remote.create(item("A", CANARY, true));
    t.mock.inject({
      method: "DELETE",
      path: "/repos/acme/svc/actions/secrets/A",
      status: 500,
      times: 1,
      body: { message: "boom" },
    });
    expect((await failure(t.remote.delete({ key: "A", scope: "*" }))).kind).toBe("failed");
    expect(t.held().secrets.A?.value).toBe(CANARY);
  });
});

describe("what GitHub cannot hold is refused with a message, before anything is sent", () => {
  test("a file", async () => {
    const t = target("repository");
    const e = await failure(t.remote.create(item("F", CANARY, false, true)));
    expect(e.kind).toBe("unsupported");
    expect(e.message).toContain("file");
    expect(e.message).not.toContain(CANARY);
    expect(t.mock.requests).toEqual([]);
  });

  test("a value over 48 KB, counted in bytes, secret or not", async () => {
    const t = target("repository");
    const limit = 48 * 1024;
    for (const secret of [false, true]) {
      // 1 byte under and exactly at the limit are taken; a two-byte character that crosses it is not
      await t.remote.create(item(`AT_${secret}`.toUpperCase(), "x".repeat(limit), secret));
      const e = await failure(
        t.remote.create(item(`OVER_${secret}`.toUpperCase(), `${"x".repeat(limit - 1)}é`, secret)),
      );
      expect(e.kind).toBe("invalid");
      expect(e.message).toContain("48 KB");
      expect(e.message).not.toContain("xxxx");
    }
  });

  test("a name GitHub would store in capitals, which the planner would never find again", async () => {
    const t = target("repository");
    const e = await failure(t.remote.create(item("lower", CANARY)));
    expect(e.kind).toBe("invalid");
    expect(e.message).toContain("capital");
    expect(t.mock.requests).toEqual([]);
  });

  test("a scope other than *", async () => {
    const t = target("repository");
    const e = await failure(t.remote.create(item("K", CANARY, false, false, "production")));
    expect(e.kind).toBe("unsupported");
    expect(t.mock.requests).toEqual([]);
  });

  test("check says the same before the target is asked", () => {
    const { adapter } = target("repository");
    for (const { item: i, kind } of refused) {
      let got: unknown;
      try {
        adapter.check(i);
      } catch (e) {
        got = e;
      }
      expect((got as SyncError).kind).toBe(kind);
    }
  });
});

describe("drift", () => {
  const fingerprint = (v: string) => createHmac("sha256", "k").update(v).digest("hex");

  /** What an apply would record: the fingerprint of what was written and the stamp GitHub gave it. */
  const recorded = (
    entries: Record<string, { value: string; changedAt?: string }>,
  ): LastApplied => ({
    fingerprint,
    get: (r) => {
      const e = entries[r.key];
      return e && fingerprint(e.value);
    },
    changedAt: (r) => entries[r.key]?.changedAt,
  });
  const summary = (items: { action: string; key: string; changed: string[] }[]) =>
    items.map((i) => `${i.action} ${i.key}${i.changed.length ? ` ${i.changed.join("+")}` : ""}`);

  test("a variable changed by hand is seen from its value", async () => {
    const t = target("repository");
    await t.remote.create(item("REGION", "eu-west-1"));
    expect(summary(plan([item("REGION", "eu-west-1")], await t.remote.read()))).toEqual([
      "noop REGION",
    ]);
    // someone edits it on GitHub
    await actionsApi(
      createGithubClient({
        baseUrl: t.mock.url,
        allowInsecureHttp: true,
        token: TOKEN,
        maxRetries: 0,
      }),
    ).variables.update({ repository: "acme/svc" }, "REGION", "us-east-1");
    expect(summary(plan([item("REGION", "eu-west-1")], await t.remote.read()))).toEqual([
      "update REGION value",
    ]);
  });

  test("a secret changed by hand is seen from the time GitHub says it changed", async () => {
    const t = target("repository");
    await t.remote.create(item("TOKEN", "one", true));
    const [first] = await t.remote.read();
    const last = recorded({ TOKEN: { value: "one", changedAt: first?.changedAt } });
    expect(first?.changedAt).toEqual(expect.any(String));
    const wanted = [item("TOKEN", "one", true)];
    expect(summary(plan(wanted, await t.remote.read(), { lastApplied: last }))).toEqual([
      "noop TOKEN",
    ]);
    // someone writes a different value on GitHub: the value is unreadable, the time is not
    await actionsApi(
      createGithubClient({
        baseUrl: t.mock.url,
        allowInsecureHttp: true,
        token: TOKEN,
        maxRetries: 0,
      }),
    ).secrets.put({ repository: "acme/svc" }, "TOKEN", "someone else's");
    expect(summary(plan(wanted, await t.remote.read(), { lastApplied: last }))).toEqual([
      "update TOKEN value",
    ]);
  });

  test("a secret nothing was recorded for is updated, since it cannot be known to be right", async () => {
    const t = target("repository");
    await t.remote.create(item("TOKEN", "one", true));
    expect(summary(plan([item("TOKEN", "one", true)], await t.remote.read()))).toEqual([
      "update TOKEN value",
    ]);
  });

  test("a secret that is wanted changed is updated whatever the time says", async () => {
    const t = target("repository");
    await t.remote.create(item("TOKEN", "one", true));
    const [first] = await t.remote.read();
    const last = recorded({ TOKEN: { value: "one", changedAt: first?.changedAt } });
    expect(
      summary(plan([item("TOKEN", "two", true)], await t.remote.read(), { lastApplied: last })),
    ).toEqual(["update TOKEN value"]);
  });

  test("a secret and a variable that swapped kinds differ in the flag", async () => {
    const t = target("repository");
    await t.remote.create(item("K", "v"));
    expect(summary(plan([item("K", "v", true)], await t.remote.read()))).toEqual([
      "update K secret",
    ]);
  });

  test("an item only GitHub has is unmanaged, and refId is by key", async () => {
    const t = target("repository");
    await t.remote.create(item("EXTRA", "v"));
    const items = plan([], await t.remote.read(), { unmanaged: "prune" });
    expect(items.map((i) => [i.action, refId(i)])).toEqual([
      ["delete", refId({ key: "EXTRA", scope: "*" })],
    ]);
  });
});

describe("no value, key or token reaches an error, a request log or a read", () => {
  test("a secret's value is in no request and no read, and the token is in no request", async () => {
    const t = target("repository");
    await t.remote.create(item("A_SECRET", CANARY, true));
    await t.remote.update(item("A_SECRET", `${CANARY}-2`, true));
    await t.remote.create(item("A_VAR", "plain"));
    for (const r of t.mock.requests) {
      expect(JSON.stringify(r)).not.toContain(CANARY);
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
    const read = await t.remote.read();
    expect(JSON.stringify(read)).not.toContain(CANARY);
    expect(read.find((i) => i.key === "A_SECRET")?.value).toBeNull();
  });

  test("a failure at GitHub is said in fixed words", async () => {
    const t = target("repository");
    t.mock.inject({
      method: "GET",
      path: "/repos/acme/svc/actions/variables",
      status: 500,
      times: 1,
      body: { message: `boom ${CANARY} ${TOKEN}` },
    });
    const e = await failure(t.remote.read());
    expect(e.kind).toBe("failed");
    expect(e.message).not.toContain(CANARY);
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).toContain("GitHub answered");
  });

  test("a token without the permission fails, in fixed words, and nothing is written", async () => {
    const mock = createMockGithub({ denied: ["/actions/secrets"] });
    mock.addRepo("acme", "svc");
    const adapter = githubActionsAdapter(
      actionsApi(
        createGithubClient({
          baseUrl: mock.url,
          allowInsecureHttp: true,
          token: TOKEN,
          maxRetries: 0,
        }),
      ),
    );
    const remote = adapter.connect(adapter.validate({ repository: "acme/svc" }));
    const e = await failure(remote.create(item("S", CANARY, true)));
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("forbidden");
    expect(mock.actions({ repository: "acme/svc" }).secrets).toEqual({});
    mock.stop();
  });

  test("a list across pages is all read", async () => {
    const t = target("repository", { maxPerPage: 2 });
    for (const k of ["A", "B", "C"]) {
      await t.remote.create(item(k, k, true));
      await t.remote.create(item(`V_${k}`, k));
    }
    expect((await t.remote.read()).map((i) => i.key)).toEqual(["A", "B", "C", "V_A", "V_B", "V_C"]);
  });
});
