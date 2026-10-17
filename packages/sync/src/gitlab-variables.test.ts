import { describe, expect, test } from "bun:test";
import { createGitlab, type Gitlab, GitlabError } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { runAdapterConformance } from "./conformance";
import { SyncError, type SyncErrorKind } from "./errors";
import { gitlabVariablesAdapter } from "./gitlab-variables";
import { plan } from "./plan";
import { ALL_SCOPES, type ItemInput } from "./types";

/** A value that must never show up in an error. */
const CANARY = "gitlab-canary-5d1e8b2f";

const item = (
  key: string,
  value: string,
  scope = ALL_SCOPES,
  secret = false,
  file = false,
): ItemInput => ({ key, scope, value, secret, file });

type Owner = "project" | "group";

/** A mock GitLab with one project and one group, and a client for it. */
function target(owner: Owner, opts: { maxPerPage?: number; protected?: boolean } = {}) {
  const mock = createMockGitlab({ maxPerPage: opts.maxPerPage });
  const group = mock.addGroup("platform");
  const project = mock.addProject({ path: "platform/api" });
  mock.addMember({ group: group.id }, mock.tokenUser.id, 40);
  mock.addMember({ project: project.id }, mock.tokenUser.id, 40);
  const gitlab = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const adapter = gitlabVariablesAdapter(gitlab);
  const where = owner === "project" ? { project: project.path } : { group: group.id };
  const config = opts.protected === undefined ? where : { ...where, protected: opts.protected };
  const of = owner === "project" ? { project: project.path } : { group: group.id };
  const remote = adapter.connect(adapter.validate(config));
  return { mock, gitlab, adapter, config, of, remote, stop: mock.stop };
}

const refused: { item: ItemInput; kind: SyncErrorKind }[] = [
  { item: item("NOT-A-KEY", CANARY), kind: "invalid" },
  { item: item("has space", CANARY), kind: "invalid" },
  { item: item("K".repeat(256), CANARY), kind: "invalid" },
  { item: item("TOO_LONG", "x".repeat(10_001)), kind: "invalid" },
  { item: item("SHORT", "abc1234", ALL_SCOPES, true), kind: "unmaskable" },
  { item: item("SPACED", "abcd efgh", ALL_SCOPES, true), kind: "unmaskable" },
  { item: item("LINES", "abcdefgh\nijklmnop", ALL_SCOPES, true), kind: "unmaskable" },
  { item: item("TRAIL", "abcdefgh\n", ALL_SCOPES, true), kind: "unmaskable" },
];

for (const owner of ["project", "group"] as const) {
  runAdapterConformance(
    `gitlab variables, ${owner}`,
    async () => {
      const t = target(owner);
      return { adapter: t.adapter, config: t.config, stop: t.stop };
    },
    { refused },
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

describe("gitlab variables config", () => {
  const { adapter } = target("project");
  test("takes a project or a group, by id or path, with protected as an option", () => {
    for (const ok of [
      { project: 5 },
      { project: "platform/api", protected: true },
      { group: "platform" },
      { group: 3, protected: false },
    ]) {
      expect(adapter.validate(ok)).toEqual(ok);
    }
  });

  test("refuses anything else without echoing it", () => {
    const bad = [
      {},
      { protected: true },
      { project: 1, group: 2 },
      { project: 0 },
      { project: -1 },
      { project: 1.5 },
      { project: "" },
      { project: null },
      { project: 1, protected: "yes" },
      { project: 1, token: CANARY },
      { project: 1, baseUrl: `https://${CANARY}.test` },
      { group: CANARY, extra: CANARY },
      { project: [CANARY] },
    ];
    for (const config of bad) {
      let caught: unknown;
      try {
        adapter.validate(config);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(SyncError);
      expect((caught as SyncError).kind).toBe("invalid_config");
      expect((caught as SyncError).message).not.toContain(CANARY);
    }
  });

  test("says what it is and what it can do", () => {
    expect(adapter.type).toBe("gitlab-variables");
    expect(adapter.capabilities).toEqual({
      canReadValues: true,
      supportsMasking: true,
      supportsScopes: true,
      supportsFiles: true,
    });
  });
});

describe("gitlab variables, what is written", () => {
  test("a secret is masked and raw, never hidden; a file is a file; the scope is kept", async () => {
    const t = target("project");
    try {
      await t.remote.create(item("TOKEN", "s3cretvalue1", "production", true));
      await t.remote.create(item("CERT", "line one\nline two", ALL_SCOPES, false, true));
      await t.remote.create(item("PLAIN", "a $VALUE", ALL_SCOPES));
      const token = await t.gitlab.variables.get(t.of, { key: "TOKEN", scope: "production" });
      expect(token).toMatchObject({
        masked: true,
        hidden: false,
        raw: true,
        protected: false,
        scope: "production",
        type: "env_var",
        description: null,
      });
      expect(token.value).toBe("s3cretvalue1");
      const cert = await t.gitlab.variables.get(t.of, { key: "CERT" });
      expect(cert).toMatchObject({ type: "file", masked: false, raw: true });
      expect((await t.gitlab.variables.get(t.of, { key: "PLAIN" })).value).toBe("a $VALUE");
    } finally {
      await t.stop();
    }
  });

  test("an update changes value, secret flag and file flag, and keeps the description", async () => {
    const t = target("project");
    try {
      await t.gitlab.variables.create(t.of, "K", {
        value: "first value",
        description: "kept by hand",
      });
      await t.remote.update(item("K", "second-value", ALL_SCOPES, true, true));
      const k = await t.gitlab.variables.get(t.of, { key: "K" });
      expect(k).toMatchObject({ masked: true, type: "file", description: "kept by hand" });
      expect(k.value).toBe("second-value");
      await t.remote.update(item("K", "third value", ALL_SCOPES, false, false));
      expect(await t.gitlab.variables.get(t.of, { key: "K" })).toMatchObject({
        masked: false,
        type: "env_var",
      });
    } finally {
      await t.stop();
    }
  });

  test("protected in the config protects what is written; left out, an update keeps what is there", async () => {
    const on = target("group", { protected: true });
    const off = target("project");
    try {
      await on.remote.create(item("A", "value"));
      expect((await on.gitlab.variables.get(on.of, { key: "A" })).protected).toBe(true);
      await off.gitlab.variables.create(off.of, "B", { value: "old", protected: true });
      await off.remote.update(item("B", "new"));
      expect(await off.gitlab.variables.get(off.of, { key: "B" })).toMatchObject({
        protected: true,
      });
      await off.remote.create(item("C", "value"));
      expect((await off.gitlab.variables.get(off.of, { key: "C" })).protected).toBe(false);
    } finally {
      await on.stop();
      await off.stop();
    }
  });
});

describe("gitlab variables, what is read", () => {
  test("every scope, a hidden variable as null, files and masking as flags, in key-then-scope order", async () => {
    const t = target("project");
    try {
      await t.gitlab.variables.create(t.of, "B", { value: "b-value" });
      await t.gitlab.variables.create(t.of, "A", { value: "a-staging", scope: "staging" });
      await t.gitlab.variables.create(t.of, "A", { value: "a-all" });
      await t.gitlab.variables.create(t.of, "A", { value: "a-prod-value", scope: "production" });
      await t.gitlab.variables.create(t.of, "H", {
        value: "hidden-value-1",
        hidden: true,
        masked: true,
      });
      await t.gitlab.variables.create(t.of, "F", { value: "file body", type: "file" });
      expect(await t.remote.read()).toEqual([
        { key: "A", scope: "*", value: "a-all", secret: false, file: false },
        { key: "A", scope: "production", value: "a-prod-value", secret: false, file: false },
        { key: "A", scope: "staging", value: "a-staging", secret: false, file: false },
        { key: "B", scope: "*", value: "b-value", secret: false, file: false },
        { key: "F", scope: "*", value: "file body", secret: false, file: true },
        { key: "H", scope: "*", value: null, secret: true, file: false },
      ]);
    } finally {
      await t.stop();
    }
  });

  test("reads every page", async () => {
    const t = target("group", { maxPerPage: 2 });
    try {
      const keys = ["E", "C", "A", "D", "B"];
      for (const key of keys) await t.gitlab.variables.create(t.of, key, { value: `v-${key}` });
      expect((await t.remote.read()).map((i) => i.key)).toEqual(["A", "B", "C", "D", "E"]);
    } finally {
      await t.stop();
    }
  });
});

describe("gitlab variables, scopes", () => {
  test("a key is its own item in each scope, and a write touches only its own", async () => {
    const t = target("project");
    try {
      await t.remote.create(item("A", "all-value"));
      await t.remote.create(item("A", "prod-value", "production"));
      await t.remote.update(item("A", "prod-new", "production"));
      expect((await t.remote.read()).map((i) => `${i.scope}=${i.value}`)).toEqual([
        "*=all-value",
        "production=prod-new",
      ]);
      await t.remote.delete({ key: "A", scope: "production" });
      expect((await t.remote.read()).map((i) => `${i.scope}=${i.value}`)).toEqual(["*=all-value"]);
    } finally {
      await t.stop();
    }
  });

  test("a scope never falls back to *: update and delete of an absent scope are not_found and change nothing", async () => {
    const t = target("project");
    try {
      await t.remote.create(item("A", "all-value"));
      expect((await failure(t.remote.update(item("A", CANARY, "staging")))).kind).toBe("not_found");
      expect((await failure(t.remote.delete({ key: "A", scope: "staging" }))).kind).toBe(
        "not_found",
      );
      expect(await t.remote.read()).toEqual([
        { key: "A", scope: "*", value: "all-value", secret: false, file: false },
      ]);
    } finally {
      await t.stop();
    }
  });

  test("the same key in another scope is not 'exists'; the same key and scope is", async () => {
    const t = target("project");
    try {
      await t.remote.create(item("A", "all-value"));
      await t.remote.create(item("A", "prod-value", "production"));
      const e = await failure(t.remote.create(item("A", CANARY, "production")));
      expect(e.kind).toBe("exists");
      expect(e.message).not.toContain(CANARY);
    } finally {
      await t.stop();
    }
  });

  test("a plan keeps scopes apart", async () => {
    const t = target("project");
    try {
      await t.remote.create(item("A", "all-value"));
      await t.remote.create(item("A", "old-value", "production"));
      const steps = plan(
        [item("A", "all-value"), item("A", "new-value", "production"), item("A", "x-value", "dev")],
        await t.remote.read(),
      );
      expect(steps.map((s) => `${s.scope}:${s.action}`)).toEqual([
        "*:noop",
        "dev:create",
        "production:update",
      ]);
    } finally {
      await t.stop();
    }
  });
});

describe("gitlab variables, secrets GitLab cannot mask", () => {
  test("check, create and update refuse them as unmaskable, naming the item and nothing of the value", async () => {
    const t = target("project");
    try {
      await t.remote.create(item("EXISTING", "plain value"));
      for (const value of ["short", "has a space in it", "line1\nline2xx"]) {
        const secret = item("S", value, ALL_SCOPES, true);
        expect(() => t.adapter.check(secret)).toThrow(SyncError);
        const c = await failure(t.remote.create(secret));
        expect(c.kind).toBe("unmaskable");
        expect(c.message).toContain('"S"');
        expect(c.message).not.toContain(value);
        const u = await failure(t.remote.update({ ...secret, key: "EXISTING" }));
        expect(u.kind).toBe("unmaskable");
      }
      expect((await t.remote.read()).map((i) => i.key)).toEqual(["EXISTING"]);
      expect((await t.gitlab.variables.get(t.of, { key: "EXISTING" })).value).toBe("plain value");
    } finally {
      await t.stop();
    }
  });

  test("the same short value is fine as a plain item, and 8 characters is enough to mask", async () => {
    const t = target("project");
    try {
      expect(() => t.adapter.check(item("P", "abc", ALL_SCOPES, false))).not.toThrow();
      expect(() => t.adapter.check(item("S", "abcdefgh", ALL_SCOPES, true))).not.toThrow();
      expect(() => t.adapter.check(item("S", "abcdefg", ALL_SCOPES, true))).toThrow(SyncError);
      await t.remote.create(item("P", "abc"));
      await t.remote.create(item("S", "abcdefgh", ALL_SCOPES, true));
      // written raw, so `$` and punctuation do not stop a value being masked
      const symbols = item("SYMBOLS", "p4$$w0rd!#%^&*()", ALL_SCOPES, true);
      expect(() => t.adapter.check(symbols)).not.toThrow();
      await t.remote.create(symbols);
      expect((await t.gitlab.variables.get(t.of, { key: "SYMBOLS" })).masked).toBe(true);
    } finally {
      await t.stop();
    }
  });

  test("a secret of any other shape is checked before the target is asked about the item", async () => {
    const t = target("project");
    try {
      // not there, so a lookup first would say not_found
      const before = t.mock.requests.length;
      expect((await failure(t.remote.update(item("NOPE", "short", ALL_SCOPES, true)))).kind).toBe(
        "unmaskable",
      );
      expect((await failure(t.remote.update(item("NO-PE", "x")))).kind).toBe("invalid");
      expect((await failure(t.remote.delete({ key: "NO-PE", scope: ALL_SCOPES }))).kind).toBe(
        "invalid",
      );
      expect(t.mock.requests.length).toBe(before);
    } finally {
      await t.stop();
    }
  });

  test("a value of 10,000 characters is taken, one more is invalid", async () => {
    const t = target("project");
    try {
      await t.remote.create(item("EDGE", "x".repeat(10_000)));
      expect((await failure(t.remote.update(item("EDGE", "x".repeat(10_001))))).kind).toBe(
        "invalid",
      );
    } finally {
      await t.stop();
    }
  });
});

describe("gitlab variables, when GitLab answers an error", () => {
  const cases: [number, string][] = [
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "server"],
  ];

  for (const [status, kind] of cases) {
    test(`${status} on create is 'failed' with fixed words, naming the item only`, async () => {
      const t = target("project");
      try {
        t.mock.inject({ method: "POST", status, times: 1 });
        const e = await failure(t.remote.create(item("K", CANARY, "production")));
        expect(e.kind).toBe("failed");
        expect(e.message).toBe(`"K" (production): GitLab answered ${kind}`);
        for (const secret of [CANARY, t.mock.token, t.mock.url]) {
          expect(e.message).not.toContain(secret);
        }
      } finally {
        await t.stop();
      }
    });
  }

  test("a failing read is 'failed'; a failing write on update and delete is 'failed' unless the item is absent", async () => {
    const t = target("project");
    try {
      await t.remote.create(item("K", "value"));
      t.mock.inject({ method: "GET", status: 500, times: 1 });
      const read = await failure(t.remote.read());
      expect(read.kind).toBe("failed");
      expect(read.message).toBe("reading the variables: GitLab answered server");
      t.mock.inject({ method: "PUT", status: 500, times: 1 });
      expect((await failure(t.remote.update(item("K", CANARY)))).kind).toBe("failed");
      t.mock.inject({ method: "DELETE", status: 500, times: 1 });
      expect((await failure(t.remote.delete({ key: "K", scope: ALL_SCOPES }))).kind).toBe("failed");
      expect((await t.remote.read()).map((i) => i.key)).toEqual(["K"]);
    } finally {
      await t.stop();
    }
  });
});

describe("gitlab variables, with a client that misbehaves", () => {
  /** A client whose calls answer as told. */
  const stub = (api: {
    create?: () => Promise<unknown>;
    get?: () => Promise<unknown>;
    update?: () => Promise<unknown>;
    delete?: () => Promise<unknown>;
    list?: () => AsyncIterable<never>;
  }) =>
    gitlabVariablesAdapter({ variables: api } as unknown as Pick<Gitlab, "variables">).connect({
      project: 1,
    });
  const reject = (e: unknown) => () => Promise.reject(e);

  test("a refused create is 'exists' if the variable is there, 'invalid' if not, 'failed' if it cannot be told", async () => {
    const refusal = new GitlabError("invalid", `refused ${CANARY}`, 400);
    for (const answer of [refusal, new GitlabError("conflict", "taken", 409)]) {
      const taken = stub({ create: reject(answer), get: async () => ({}) });
      expect((await failure(taken.create(item("K", "v")))).kind).toBe("exists");
    }
    const absent = new GitlabError("not_found", "no", 404);
    const invalid = await failure(
      stub({ create: reject(refusal), get: reject(absent) }).create(item("K", CANARY)),
    );
    expect(invalid.kind).toBe("invalid");
    expect(invalid.message).not.toContain(CANARY);
    const unknown = await failure(
      stub({ create: reject(refusal), get: reject(new GitlabError("server", "x", 500)) }).create(
        item("K", "v"),
      ),
    );
    expect(unknown.kind).toBe("failed");
    expect(unknown.message).toBe('"K" (*): GitLab answered server');
  });

  test("an error that is not GitLab's, with a value in it, never reaches the message", async () => {
    const error = new Error(`boom ${CANARY}`);
    const boom = reject(error);
    const remote = stub({
      create: boom,
      update: boom,
      delete: boom,
      list: () => ({ [Symbol.asyncIterator]: () => ({ next: boom }) }),
    });
    for (const call of [
      () => remote.create(item("K", CANARY)),
      () => remote.update(item("K", CANARY)),
      () => remote.delete({ key: "K", scope: ALL_SCOPES }),
      () => remote.read(),
    ]) {
      const e = await failure(call());
      expect(e.kind).toBe("failed");
      expect(e.message).toContain("the request could not be made");
      expect(e.message).not.toContain(CANARY);
    }
  });

  test("a GitLab error with a value, a token or a URL in its text is not passed on", async () => {
    const leaky = new GitlabError("server", `${CANARY} https://gitlab.example/api glpat-abc`, 500);
    for (const kind of ["create", "update", "delete"] as const) {
      const remote = stub({ [kind]: reject(leaky) });
      const run = {
        create: () => remote.create(item("K", "value")),
        update: () => remote.update(item("K", "value")),
        delete: () => remote.delete({ key: "K", scope: ALL_SCOPES }),
      }[kind];
      const e = await failure(run());
      expect(e.message).toBe('"K" (*): GitLab answered server');
    }
  });

  test("a long key is cut in a message", async () => {
    const t = target("project");
    try {
      const e = await failure(t.remote.create(item("K".repeat(300), CANARY)));
      expect(e.kind).toBe("invalid");
      expect(e.message.length).toBeLessThan(200);
    } finally {
      await t.stop();
    }
  });
});

describe("gitlab variables, plan then apply", () => {
  test("applying a plan makes the next plan empty, and a prune takes what nothing wants", async () => {
    const t = target("project");
    try {
      await t.remote.create(item("KEEP", "same value"));
      await t.remote.create(item("CHANGE", "old value"));
      await t.remote.create(item("DROP", "drop value"));
      await t.remote.create(item("FLIP", "flip-value-1"));
      const desired = [
        item("KEEP", "same value"),
        item("CHANGE", "new value"),
        item("FLIP", "flip-value-1", ALL_SCOPES, true),
        item("NEW", "n-value-123", "production", true),
        item("FILE", "body", ALL_SCOPES, false, true),
      ];
      for (const d of desired) t.adapter.check(d);
      const steps = plan(desired, await t.remote.read(), { unmanaged: "prune" });
      expect(steps.map((s) => `${s.key}@${s.scope}:${s.action}:${s.changed.join("+")}`)).toEqual([
        "CHANGE@*:update:value",
        "DROP@*:delete:",
        "FILE@*:create:",
        "FLIP@*:update:secret",
        "KEEP@*:noop:",
        "NEW@production:create:",
      ]);
      for (const s of steps) {
        const want = desired.find((d) => d.key === s.key && d.scope === s.scope);
        if (s.action === "create" && want) await t.remote.create(want);
        if (s.action === "update" && want) await t.remote.update(want);
        if (s.action === "delete") await t.remote.delete(s);
      }
      const again = plan(desired, await t.remote.read(), { unmanaged: "prune" });
      expect(again.every((s) => s.action === "noop")).toBe(true);
      expect(again).toHaveLength(desired.length);
    } finally {
      await t.stop();
    }
  });
});
