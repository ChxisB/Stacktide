import { describe, expect, test } from "bun:test";
import type { AwsCreds } from "./aws";
import { OWNER_TAG } from "./aws-common";
import { assumedSession } from "./aws-json";
import { AWS_SM, awsSmAdapter, LAYOUT_TAG, PLAIN_TAG, parseAwsSmConfig } from "./aws-sm";
import { runAdapterConformance } from "./conformance";
import { SyncError } from "./errors";
import { type FakeAwsOptions, fakeAws } from "./fake-aws";
import type { Fetch } from "./http";
import { ALL_SCOPES, type ItemInput } from "./types";

const BASE: AwsCreds = {
  accessKeyId: "AKIAPLATFORM000000",
  secretAccessKey: "base-secret-key-CANARY-0123456789",
};
const ROLE = "arn:aws:iam::111122223333:role/orch-sync";
const EXTERNAL_ID = "ext-id-CANARY-0123456789";
const REGION = "eu-west-1";
const PREFIX = "/team/app";
const perKey = { region: REGION, prefix: PREFIX };
const perScope = { ...perKey, layout: "per-scope" as const };
const LEAK = "aws-leak-CANARY-9d41";
const VALUE = "value-CANARY-5b2e";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const item = (key: string, value: string, scope = ALL_SCOPES, secret = true): ItemInput => ({
  key,
  scope,
  value,
  secret,
  file: false,
});
const ours = (layout: string, extra: Record<string, string> = {}) => ({
  [OWNER_TAG]: PREFIX,
  [LAYOUT_TAG]: layout,
  ...extra,
});

/** An account with Secrets Manager, the role, and an adapter that reaches it the way the platform does. */
function world(cfg: Record<string, unknown> = perKey, opts: Partial<FakeAwsOptions> = {}) {
  let clock = new Date("2030-01-01T00:00:00Z");
  const aws = fakeAws({
    base: BASE,
    roleArn: ROLE,
    externalId: EXTERNAL_ID,
    region: REGION,
    now: () => clock,
    pageSize: 3,
    leak: LEAK,
    ...opts,
  });
  const connect = (fetch: Fetch, c: Record<string, unknown> = cfg) => {
    const deps = { fetch, now: () => clock };
    const adapter = awsSmAdapter(
      assumedSession(deps, BASE, { roleArn: ROLE, region: REGION, externalId: EXTERNAL_ID }),
      deps,
    );
    return { adapter, remote: adapter.connect(adapter.validate(c)) };
  };
  return {
    aws,
    ...connect(aws.fetch),
    /** The same account seen through a fetch that does something between the answers. */
    through: (fetch: (real: Fetch) => Fetch, c?: Record<string, unknown>) =>
      connect(fetch(aws.fetch), c).remote,
    /** Another target on the same account. */
    other: (c: Record<string, unknown>) => connect(aws.fetch, c).remote,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
type World = ReturnType<typeof world>;
const sm = (w: World, action: string) =>
  w.aws.calls.filter((c) => c.service === "secretsmanager" && c.action === action);
const body = (w: World, action: string) =>
  sm(w, action).map((c) => c.body as Record<string, unknown>);
const tagsOf = (w: World, name: string) => w.aws.secrets.get(name)?.tags;
const object = (w: World, name: string) => JSON.parse(w.aws.secretValue(name) ?? "null");
/** A fetch that runs `before` when the named action is about to be answered. */
const racing =
  (action: string, run: () => void): ((real: Fetch) => Fetch) =>
  (real) =>
  async (url, init) => {
    const res = await real(url, init);
    if (new Headers(init.headers).get("x-amz-target") === `secretsmanager.${action}`) run();
    return res;
  };

// what no layout can hold, and what check says before anything is asked
const refused = [
  { item: item("K", ""), kind: "invalid" as const },
  { item: item("K", "x".repeat(65537)), kind: "invalid" as const },
  { item: item("has space", "v"), kind: "invalid" as const },
  { item: item("a/b", "v"), kind: "invalid" as const },
  { item: item("..", "v"), kind: "invalid" as const },
  { item: item("K", "v", "prod*"), kind: "invalid" as const },
  { item: item("K", "v", "a/b"), kind: "invalid" as const },
];
for (const [name, cfg] of [
  ["per-key", perKey],
  ["per-scope", perScope],
] as const) {
  runAdapterConformance(
    `aws-sm ${name} (contract fake)`,
    async () => ({ adapter: world(cfg).adapter, config: cfg }),
    { refused },
  );
}

describe("the config", () => {
  test("a region and a prefix, and optionally a layout, a KMS key and protected", () => {
    expect(parseAwsSmConfig(perKey)).toEqual(perKey);
    const full = { ...perScope, kmsKeyId: "alias/orch", protected: true };
    expect(parseAwsSmConfig(full)).toEqual(full);
    expect(AWS_SM).toBe("aws-sm");
  });

  test("anything else is invalid_config, and says what the config is", () => {
    for (const bad of [
      {},
      { region: REGION },
      { ...perKey, layout: "per-environment" },
      { ...perKey, extra: 1 },
      { ...perKey, prefix: "/aws/app" },
      { ...perKey, prefix: "/team/" },
      { ...perKey, prefix: "team/app" },
      { ...perKey, region: "mars" },
      { ...perKey, kmsKeyId: "a b" },
      null,
    ]) {
      let e: unknown;
      try {
        parseAwsSmConfig(bad);
      } catch (x) {
        e = x;
      }
      expect([bad, e instanceof SyncError && e.kind]).toEqual([bad, "invalid_config"]);
    }
  });
});

describe("check", () => {
  test("is about the item and not the target: a file, a name, a size in bytes", () => {
    const w = world();
    const kind = (i: ItemInput) => {
      try {
        w.adapter.check(i);
      } catch (e) {
        return e instanceof SyncError && e.kind;
      }
    };
    expect(kind({ ...item("F", "v"), file: true })).toBe("unsupported");
    expect(kind(item("K", ""))).toBe("invalid");
    // 65536 bytes is two bytes a character for 32768 of them: characters would let 65537 through
    expect(kind(item("K", "é".repeat(32768)))).toBeUndefined();
    expect(kind(item("K", `${"é".repeat(32768)}a`))).toBe("invalid");
    expect(kind(item("K", "a".repeat(65536)))).toBeUndefined();
    expect(kind(item("K".repeat(101), "v"))).toBe("invalid");
    expect(kind(item("K".repeat(100), "v"))).toBeUndefined();
    // {{ }} is nothing special to Secrets Manager
    expect(kind(item("K", "a {{b}} c"))).toBeUndefined();
  });

  test("a name that ends like an ARN, or a scope _ in the per-scope layout, is refused by the write, before AWS is asked", async () => {
    const key = world();
    await expect(key.remote.create(item("TOKEN-abc123", "v"))).rejects.toMatchObject({
      kind: "invalid",
    });
    // the same ending is fine where it is a scope level and not the end of the name
    await key.remote.create(item("K", "v", "stage-abc123"));
    const scope = world(perScope);
    await expect(scope.remote.create(item("K", "v", "stage-abc123"))).rejects.toMatchObject({
      kind: "invalid",
    });
    await expect(scope.remote.create(item("K", "v", "_"))).rejects.toMatchObject({
      kind: "invalid",
    });
    await scope.remote.create(item("TOKEN-abc123", "v"));
    expect(sm(key, "CreateSecret")).toHaveLength(1);
    expect(sm(scope, "CreateSecret")).toHaveLength(1);
    expect(sm(scope, "DescribeSecret")).toHaveLength(1);
  });
});

describe("one secret per key", () => {
  test("a key is a secret under the prefix, a scope is a level between, and every one is tagged", async () => {
    const w = world();
    await w.remote.create(item("API_KEY", VALUE));
    await w.remote.create(item("DB_URL", "db", "production"));
    expect(w.aws.secretValue("/team/app/API_KEY")).toBe(VALUE);
    expect(w.aws.secretValue("/team/app/production/DB_URL")).toBe("db");
    expect(tagsOf(w, "/team/app/API_KEY")).toEqual(ours("per-key"));
    const [first] = body(w, "CreateSecret");
    expect(first?.ClientRequestToken).toMatch(UUID);
    expect(first).not.toHaveProperty("KmsKeyId");
    expect(await w.remote.read()).toEqual([
      { key: "API_KEY", scope: "*", value: VALUE, secret: true, file: false },
      { key: "DB_URL", scope: "production", value: "db", secret: true, file: false },
    ]);
  });

  test("the KMS key is named when a secret is made, and the value keeps its bytes", async () => {
    const w = world({ ...perKey, kmsKeyId: "alias/orch" });
    const odd = ' lead\n\ttab é中 {"json": 1}\r\ntrail ';
    await w.remote.create(item("K", odd));
    expect(body(w, "CreateSecret")[0]?.KmsKeyId).toBe("alias/orch");
    expect(w.aws.secrets.get("/team/app/K")?.kmsKeyId).toBe("alias/orch");
    expect((await w.remote.read())[0]?.value).toBe(odd);
  });

  test("the secret flag is a tag on the key that is not one, and survives a read", async () => {
    const w = world();
    await w.remote.create(item("SECRET", "s", ALL_SCOPES, true));
    await w.remote.create(item("PLAIN", "p", ALL_SCOPES, false));
    expect(tagsOf(w, "/team/app/SECRET")).toEqual(ours("per-key"));
    expect(tagsOf(w, "/team/app/PLAIN")).toEqual(ours("per-key", { [`${PLAIN_TAG}PLAIN`]: "1" }));
    expect((await w.remote.read()).map((i) => [i.key, i.secret])).toEqual([
      ["PLAIN", false],
      ["SECRET", true],
    ]);
  });

  test("an update flips the flag with a tag call, and only when the flag changed", async () => {
    const w = world();
    await w.remote.create(item("K", "1", ALL_SCOPES, true));
    await w.remote.update(item("K", "2", ALL_SCOPES, true));
    expect(sm(w, "TagResource").length + sm(w, "UntagResource").length).toBe(0);
    await w.remote.update(item("K", "3", ALL_SCOPES, false));
    expect(tagsOf(w, "/team/app/K")).toEqual(ours("per-key", { [`${PLAIN_TAG}K`]: "1" }));
    await w.remote.update(item("K", "4", ALL_SCOPES, false));
    expect(sm(w, "TagResource")).toHaveLength(1);
    await w.remote.update(item("K", "5", ALL_SCOPES, true));
    expect(tagsOf(w, "/team/app/K")).toEqual(ours("per-key"));
    expect(body(w, "UntagResource")).toEqual([
      { SecretId: "/team/app/K", TagKeys: [`${PLAIN_TAG}K`] },
    ]);
    expect(await w.remote.read()).toEqual([
      { key: "K", scope: "*", value: "5", secret: true, file: false },
    ]);
  });

  test("a new value is a new version that takes AWSCURRENT, and a read asks for nothing else", async () => {
    const w = world();
    await w.remote.create(item("K", "one"));
    await w.remote.update(item("K", "two"));
    await w.remote.update(item("K", "three"));
    const stages = w.aws.secrets.get("/team/app/K")?.versions.map((v) => [v.value, v.stages]);
    expect(stages).toEqual([
      ["one", []],
      ["two", ["AWSPREVIOUS"]],
      ["three", ["AWSCURRENT"]],
    ]);
    const tokens = body(w, "PutSecretValue").map((b) => b.ClientRequestToken);
    expect(tokens).toHaveLength(2);
    for (const t of tokens) expect(t).toMatch(UUID);
    expect(new Set(tokens).size).toBe(2);
    // a version a rotation is still preparing is not what the secret is
    w.aws.secrets
      .get("/team/app/K")
      ?.versions.push({ id: "pending", token: "pending", value: "next", stages: ["AWSPENDING"] });
    expect((await w.remote.read())[0]?.value).toBe("three");
    for (const b of body(w, "GetSecretValue")) expect(b).not.toHaveProperty("VersionStage");
  });

  test("an update puts a value back that an older version held", async () => {
    const w = world();
    await w.remote.create(item("K", "a"));
    await w.remote.update(item("K", "b"));
    await w.remote.update(item("K", "a"));
    expect(w.aws.secretValue("/team/app/K")).toBe("a");
  });

  test("create finds a secret that is there; update and delete find none; and nothing is changed", async () => {
    const w = world();
    w.aws.seedSecret("/team/app/HAND", "by hand");
    w.aws.seedSecret("/team/app/OTHERS", "another prefix", {
      [OWNER_TAG]: "/team",
      [LAYOUT_TAG]: "per-key",
    });
    for (const k of ["HAND", "OTHERS"]) {
      const e = await w.remote.create(item(k, VALUE)).catch((x: unknown) => x);
      expect(e).toMatchObject({ kind: "exists" });
      expect((e as SyncError).message).toContain(`${OWNER_TAG}=${PREFIX}`);
      await expect(w.remote.update(item(k, VALUE))).rejects.toMatchObject({ kind: "not_found" });
      await expect(w.remote.delete({ key: k, scope: ALL_SCOPES })).rejects.toMatchObject({
        kind: "not_found",
      });
    }
    expect(w.aws.secretValue("/team/app/HAND")).toBe("by hand");
    expect(w.aws.secretValue("/team/app/OTHERS")).toBe("another prefix");
    for (const a of ["CreateSecret", "PutSecretValue", "DeleteSecret", "TagResource"]) {
      expect([a, sm(w, a).length]).toEqual([a, 0]);
    }
  });

  test("a read lists only the secrets this target made, in a place an item can be", async () => {
    const w = world();
    await w.remote.create(item("MINE", "m"));
    w.aws.seedSecret("/team/app/HAND", "untagged");
    w.aws.seedSecret("/team/app/ELSEWHERE", "another prefix", {
      [OWNER_TAG]: "/team",
      [LAYOUT_TAG]: "per-key",
    });
    w.aws.seedSecret("/team/app/PERSCOPE", "{}", ours("per-scope"));
    w.aws.seedSecret("/team/app/NOLAYOUT", "old", { [OWNER_TAG]: PREFIX });
    // the tag filter is a prefix match: a tag whose name only starts like ours passes it
    w.aws.seedSecret("/team/app/ALMOST", "x", { [`${OWNER_TAG}-too`]: PREFIX });
    w.aws.seedSecret("/team/app/prod/DEEP/ER", "too deep", ours("per-key"));
    w.aws.seedSecret("/team/app/TOKEN-abc123", "never named by us", ours("per-key"));
    w.aws.seedSecret("/team/other/KEY", "outside", ours("per-key"));
    w.aws.seedSecret("/team/app2/KEY", "a sibling", ours("per-key"));
    expect((await w.remote.read()).map((i) => i.key)).toEqual(["MINE"]);
  });

  test("a delete is a scheduled deletion with a recovery window, and the key is gone from the target", async () => {
    const w = world();
    await w.remote.create(item("GONE", "g"));
    await w.remote.create(item("STAYS", "s"));
    await w.remote.delete({ key: "GONE", scope: ALL_SCOPES });
    expect(body(w, "DeleteSecret")).toEqual([
      { SecretId: "/team/app/GONE", RecoveryWindowInDays: 30 },
    ]);
    expect((await w.remote.read()).map((i) => i.key)).toEqual(["STAYS"]);
    // it is not there for a second delete or an update
    await expect(w.remote.delete({ key: "GONE", scope: ALL_SCOPES })).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(w.remote.update(item("GONE", "again"))).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(sm(w, "DeleteSecret")).toHaveLength(1);
  });

  test("a key made again inside the recovery window brings its secret back with the new value and flag", async () => {
    const w = world();
    await w.remote.create(item("AGAIN", "a", ALL_SCOPES, true));
    await w.remote.delete({ key: "AGAIN", scope: ALL_SCOPES });
    await w.remote.create(item("AGAIN", VALUE, ALL_SCOPES, false));
    expect(body(w, "RestoreSecret")).toEqual([{ SecretId: "/team/app/AGAIN" }]);
    expect(sm(w, "CreateSecret")).toHaveLength(1);
    expect(w.aws.secrets.get("/team/app/AGAIN")?.deletedAt).toBeUndefined();
    expect(await w.remote.read()).toEqual([
      { key: "AGAIN", scope: "*", value: VALUE, secret: false, file: false },
    ]);
    expect(tagsOf(w, "/team/app/AGAIN")).toEqual(ours("per-key", { [`${PLAIN_TAG}AGAIN`]: "1" }));
  });

  test("a secret that someone else scheduled for deletion is not restored, and the name is taken", async () => {
    const w = world();
    w.aws.seedSecret("/team/app/THEIRS", "theirs", {});
    w.aws.seedSecret("/team/app/OURS", "ours", ours("per-key"));
    for (const k of ["THEIRS", "OURS"]) {
      const s = w.aws.secrets.get(`/team/app/${k}`);
      if (s) s.deletedAt = new Date("2030-02-01T00:00:00Z");
    }
    await expect(w.remote.create(item("THEIRS", VALUE))).rejects.toMatchObject({ kind: "exists" });
    await expect(w.remote.update(item("OURS", VALUE))).rejects.toMatchObject({ kind: "not_found" });
    await expect(w.remote.delete({ key: "OURS", scope: ALL_SCOPES })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(sm(w, "RestoreSecret")).toHaveLength(0);
    expect(sm(w, "PutSecretValue")).toHaveLength(0);
  });

  test("a scope's secret that was scheduled for deletion is not restored, and the error says why", async () => {
    const w = world(perScope);
    w.aws.seedSecret("/team/app/production", '{"A":"a"}', ours("per-scope"));
    const s = w.aws.secrets.get("/team/app/production");
    if (s) s.deletedAt = new Date("2030-02-01T00:00:00Z");
    const e = await w.remote.create(item("B", VALUE, "production")).catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: "failed" });
    expect((e as SyncError).message).toContain("scheduled for deletion");
    expect((e as SyncError).message).not.toContain(VALUE);
    expect(sm(w, "RestoreSecret")).toHaveLength(0);
  });

  test("a secret deleted between the check and its delete is already gone", async () => {
    const w = world();
    await w.remote.create(item("RACE", "r"));
    const remote = w.through(
      racing("DescribeSecret", () => {
        w.aws.secrets.delete("/team/app/RACE");
      }),
    );
    await expect(remote.delete({ key: "RACE", scope: ALL_SCOPES })).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  test("a read follows ListSecrets pages whatever order they come in", async () => {
    const w = world();
    for (const k of "HGFEDCBA".split("")) await w.remote.create(item(k, k.toLowerCase()));
    const read = await w.remote.read();
    expect(read.map((i) => i.key)).toEqual("ABCDEFGH".split(""));
    expect(sm(w, "ListSecrets").length).toBe(3);
    const filters = body(w, "ListSecrets")[0]?.Filters;
    expect(filters).toEqual([
      { Key: "name", Values: ["/team/app/"] },
      { Key: "tag-key", Values: [OWNER_TAG] },
    ]);
  });

  test("a secret deleted between the listing and the read is skipped", async () => {
    const w = world();
    await w.remote.create(item("A", "a"));
    await w.remote.create(item("B", "b"));
    const remote = w.through(
      racing("ListSecrets", () => {
        w.aws.secrets.delete("/team/app/B");
      }),
    );
    expect((await remote.read()).map((i) => i.key)).toEqual(["A"]);
  });

  test("a secret scheduled for deletion between the listing and the read is skipped", async () => {
    const w = world();
    await w.remote.create(item("A", "a"));
    await w.remote.create(item("B", "b"));
    const remote = w.through(
      racing("ListSecrets", () => {
        const b = w.aws.secrets.get("/team/app/B");
        if (b) b.deletedAt = new Date();
      }),
    );
    expect((await remote.read()).map((i) => i.key)).toEqual(["A"]);
  });

  test("a refused read of a secret that is not deleted fails the read, not a quiet gap", async () => {
    const w = world();
    await w.remote.create(item("A", "a"));
    await w.remote.create(item("B", "b"));
    const remote = w.through(
      (real) => async (url, init) =>
        new Headers(init.headers).get("x-amz-target") === "secretsmanager.GetSecretValue"
          ? Response.json({ __type: "InvalidRequestException" }, { status: 400 })
          : real(url, init),
    );
    const e = await remote.read().catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: "failed" });
    expect((e as SyncError).message).toContain("InvalidRequestException");
  });

  test("a secret that holds no text is not an item", async () => {
    const w = world();
    await w.remote.create(item("A", "a"));
    const remote = w.through(
      (real) => async (url, init) =>
        new Headers(init.headers).get("x-amz-target") === "secretsmanager.GetSecretValue"
          ? Response.json({ Name: "/team/app/A", SecretBinary: "AAEC" })
          : real(url, init),
    );
    expect(await remote.read()).toEqual([]);
  });
});

describe("one secret per scope", () => {
  test("a scope is a secret that holds its keys as a JSON object, and `*` is the secret _", async () => {
    const w = world(perScope);
    await w.remote.create(item("A", "1", "production"));
    await w.remote.create(item("B", "2", "production", false));
    await w.remote.create(item("C", "3"));
    expect(object(w, "/team/app/production")).toEqual({ A: "1", B: "2" });
    expect(object(w, "/team/app/_")).toEqual({ C: "3" });
    expect(tagsOf(w, "/team/app/production")).toEqual(
      ours("per-scope", { [`${PLAIN_TAG}B`]: "1" }),
    );
    expect(sm(w, "CreateSecret")).toHaveLength(2);
    expect(await w.remote.read()).toEqual([
      { key: "A", scope: "production", value: "1", secret: true, file: false },
      { key: "B", scope: "production", value: "2", secret: false, file: false },
      { key: "C", scope: "*", value: "3", secret: true, file: false },
    ]);
  });

  /** A secret this target made, with keys that it did not: a number, an object, and a string. */
  const withHandKeys = () => {
    const w = world(perScope);
    const hand = { HAND: "hand", COUNT: 5, NESTED: { a: [1, 2] }, "odd key": "x" };
    w.aws.seedSecret("/team/app/production", JSON.stringify(hand), ours("per-scope"));
    return w;
  };

  test("a write puts back every key it did not touch, whatever it holds", async () => {
    const w = withHandKeys();
    await w.remote.create(item("NEW", "n", "production"));
    expect(object(w, "/team/app/production")).toEqual({
      HAND: "hand",
      COUNT: 5,
      NESTED: { a: [1, 2] },
      "odd key": "x",
      NEW: "n",
    });
    await w.remote.update(item("HAND", "changed", "production"));
    expect(object(w, "/team/app/production")).toEqual({
      HAND: "changed",
      COUNT: 5,
      NESTED: { a: [1, 2] },
      "odd key": "x",
      NEW: "n",
    });
    await w.remote.delete({ key: "NEW", scope: "production" });
    expect(object(w, "/team/app/production")).toEqual({
      HAND: "changed",
      COUNT: 5,
      NESTED: { a: [1, 2] },
      "odd key": "x",
    });
    // only keys a variable can be named are items
    expect((await w.remote.read()).map((i) => i.key)).toEqual(["HAND"]);
    expect(sm(w, "CreateSecret")).toHaveLength(0);
  });

  test("create finds a key that is there, update and delete find none, and nothing is written", async () => {
    const w = withHandKeys();
    await expect(w.remote.create(item("HAND", "v", "production"))).rejects.toMatchObject({
      kind: "exists",
    });
    // a key of another type is there too: create does not replace it, and the engine's update does
    await expect(w.remote.create(item("COUNT", "v", "production"))).rejects.toMatchObject({
      kind: "exists",
    });
    await expect(w.remote.update(item("MISSING", "v", "production"))).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(w.remote.delete({ key: "MISSING", scope: "production" })).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(w.remote.update(item("K", "v", "nowhere"))).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(sm(w, "PutSecretValue")).toHaveLength(0);
    expect(sm(w, "CreateSecret")).toHaveLength(0);
    await w.remote.update(item("COUNT", "6", "production"));
    expect(object(w, "/team/app/production").COUNT).toBe("6");
  });

  test("the last key out leaves an empty object that the scope can be filled again from", async () => {
    const w = world(perScope);
    await w.remote.create(item("ONLY", "1", "production", false));
    await w.remote.delete({ key: "ONLY", scope: "production" });
    expect(object(w, "/team/app/production")).toEqual({});
    expect(tagsOf(w, "/team/app/production")).toEqual(ours("per-scope"));
    expect(await w.remote.read()).toEqual([]);
    await w.remote.create(item("AGAIN", "2", "production"));
    expect(object(w, "/team/app/production")).toEqual({ AGAIN: "2" });
    expect(sm(w, "DeleteSecret")).toHaveLength(0);
  });

  test("a key named __proto__ is kept like any other", async () => {
    const w = world(perScope);
    await w.remote.create(item("__proto__", "p", "production"));
    await w.remote.create(item("OTHER", "o", "production"));
    expect(w.aws.secretValue("/team/app/production")).toBe('{"__proto__":"p","OTHER":"o"}');
    expect((await w.remote.read()).map((i) => [i.key, i.value])).toEqual([
      ["OTHER", "o"],
      ["__proto__", "p"],
    ]);
    await w.remote.delete({ key: "__proto__", scope: "production" });
    expect(object(w, "/team/app/production")).toEqual({ OTHER: "o" });
  });

  test("a secret that is tagged for this target but is not a JSON object is never overwritten", async () => {
    for (const text of ["plain text", "[1,2]", "null", "5"]) {
      const w = world(perScope);
      w.aws.seedSecret("/team/app/production", text, ours("per-scope"));
      const read = await w.remote.read().catch((x: unknown) => x);
      expect(read).toMatchObject({ kind: "failed" });
      expect((read as SyncError).message).toContain("/team/app/production");
      expect((read as SyncError).message).not.toContain("plain text");
      await expect(w.remote.create(item("K", VALUE, "production"))).rejects.toMatchObject({
        kind: "failed",
      });
      await expect(w.remote.delete({ key: "K", scope: "production" })).rejects.toMatchObject({
        kind: "failed",
      });
      expect(w.aws.secretValue("/team/app/production")).toBe(text);
    }
  });

  test("the secret may not outgrow 65536 bytes, and nothing is written when it would", async () => {
    const w = world(perScope);
    await w.remote.create(item("BIG", "x".repeat(65000), "production"));
    const e = await w.remote
      .create(item("MORE", "y".repeat(600), "production"))
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: "invalid" });
    expect((e as SyncError).message).not.toContain("yyyy");
    expect(Object.keys(object(w, "/team/app/production"))).toEqual(["BIG"]);
    expect(sm(w, "PutSecretValue")).toHaveLength(0);
  });

  test("a first key whose JSON is bigger than its value is refused before the secret is made", async () => {
    const w = world(perScope);
    // 65536 bytes of quotes are fine as a value and 131074 bytes as JSON
    const e = await w.remote
      .create(item("Q", '"'.repeat(65536), "production"))
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ kind: "invalid" });
    expect(sm(w, "CreateSecret")).toHaveLength(0);
    expect(w.aws.secrets.size).toBe(0);
  });

  test("the flag of each key is its own tag, set and cleared with the key", async () => {
    const w = world(perScope);
    await w.remote.create(item("A", "1", "production", false));
    await w.remote.create(item("B", "2", "production", true));
    await w.remote.update(item("B", "3", "production", false));
    expect(Object.keys(tagsOf(w, "/team/app/production") ?? {}).sort()).toEqual(
      [OWNER_TAG, LAYOUT_TAG, `${PLAIN_TAG}A`, `${PLAIN_TAG}B`].sort(),
    );
    await w.remote.update(item("A", "1", "production", true));
    await w.remote.delete({ key: "B", scope: "production" });
    expect(tagsOf(w, "/team/app/production")).toEqual(ours("per-scope"));
    expect(await w.remote.read()).toEqual([
      { key: "A", scope: "production", value: "1", secret: true, file: false },
    ]);
  });

  test("a secret that someone else made under the name of a scope is not ours to change", async () => {
    const w = world(perScope);
    w.aws.seedSecret("/team/app/production", '{"THEIRS":"t"}');
    await expect(w.remote.create(item("K", "v", "production"))).rejects.toMatchObject({
      kind: "exists",
    });
    await expect(w.remote.update(item("THEIRS", "v", "production"))).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(w.remote.delete({ key: "THEIRS", scope: "production" })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(w.aws.secretValue("/team/app/production")).toBe('{"THEIRS":"t"}');
    expect(sm(w, "PutSecretValue")).toHaveLength(0);
    expect(await w.remote.read()).toEqual([]);
  });
});

describe("two targets on one account", () => {
  test("the two layouts do not see or change each other's secrets", async () => {
    const w = world(perKey);
    const scoped = w.other(perScope);
    await w.remote.create(item("A", "per key"));
    await scoped.create(item("A", "per scope", "production"));
    await scoped.create(item("B", "per scope"));
    expect((await w.remote.read()).map((i) => [i.key, i.scope, i.value])).toEqual([
      ["A", "*", "per key"],
    ]);
    expect((await scoped.read()).map((i) => [i.key, i.scope, i.value])).toEqual([
      ["A", "production", "per scope"],
      ["B", "*", "per scope"],
    ]);
    // the name /team/app/A is the per-key secret; the per-scope layout meets it as a secret it did not make
    await expect(scoped.create(item("K", "v", "A"))).rejects.toMatchObject({ kind: "exists" });
    await expect(scoped.update(item("K", "v", "A"))).rejects.toMatchObject({ kind: "not_found" });
    expect(w.aws.secretValue("/team/app/A")).toBe("per key");
  });

  test("targets with overlapping prefixes do not see or change each other's secrets", async () => {
    const w = world(perKey);
    const inner = w.other({ region: REGION, prefix: "/team/app/inner" });
    await w.remote.create(item("A", "outer"));
    await inner.create(item("A", "inner"));
    expect(w.aws.secretValue("/team/app/A")).toBe("outer");
    expect(w.aws.secretValue("/team/app/inner/A")).toBe("inner");
    expect((await w.remote.read()).map((i) => i.value)).toEqual(["outer"]);
    expect((await inner.read()).map((i) => i.value)).toEqual(["inner"]);
    await expect(inner.delete({ key: "A", scope: "*" })).resolves.toBeUndefined();
    expect(w.aws.secretValue("/team/app/A")).toBe("outer");
  });
});

describe("failures", () => {
  const ops: [string, (w: World) => Promise<unknown>][] = [
    ["ListSecrets", (w) => w.remote.read()],
    ["GetSecretValue", (w) => w.remote.read()],
    ["CreateSecret", (w) => w.remote.create(item("NEW", VALUE))],
    ["DescribeSecret", (w) => w.remote.update(item("K", VALUE))],
    ["PutSecretValue", (w) => w.remote.update(item("K", VALUE))],
    ["TagResource", (w) => w.remote.update(item("K", VALUE, ALL_SCOPES, false))],
    ["DeleteSecret", (w) => w.remote.delete({ key: "K", scope: ALL_SCOPES })],
  ];

  test("each refusal is `failed` in fixed words with AWS's name for it, never AWS's text or a value", async () => {
    for (const [action, run] of ops) {
      const w = world();
      await w.remote.create(item("K", "k"));
      w.aws.denied.add(action);
      const e = await run(w).catch((x: unknown) => x);
      expect([action, e instanceof SyncError && e.kind]).toEqual([action, "failed"]);
      const message = (e as SyncError).message;
      expect(message).toContain("AWS answered forbidden (AccessDeniedException)");
      for (const s of [LEAK, VALUE, EXTERNAL_ID, BASE.secretAccessKey, "CANARY"]) {
        expect(message).not.toContain(s);
      }
    }
  });

  test("the same in the per-scope layout", async () => {
    for (const action of ["GetSecretValue", "PutSecretValue", "UntagResource"]) {
      const w = world(perScope);
      await w.remote.create(item("K", "k", "production", false));
      w.aws.denied.add(action);
      const run =
        action === "GetSecretValue"
          ? w.remote.read()
          : action === "PutSecretValue"
            ? w.remote.update(item("K", VALUE, "production", false))
            : w.remote.update(item("K", VALUE, "production", true));
      const e = await run.catch((x: unknown) => x);
      expect([action, e instanceof SyncError && e.kind]).toEqual([action, "failed"]);
      for (const s of [LEAK, VALUE, "CANARY"]) expect((e as SyncError).message).not.toContain(s);
    }
  });

  test("an answer that is not what Secrets Manager says is a failure, not an empty target", async () => {
    const w = world();
    const remote = w.through(
      (real) => async (url, init) =>
        new Headers(init.headers).get("x-amz-target") === "secretsmanager.ListSecrets"
          ? Response.json({ SecretList: "none" })
          : real(url, init),
    );
    await expect(remote.read()).rejects.toMatchObject({
      kind: "failed",
      message: "reading the secrets: AWS answered something unexpected",
    });
  });

  test("a value that is rejected is never in the error", async () => {
    const w = world();
    await w.remote.create(item("K", "k"));
    w.aws.denied.add("PutSecretValue");
    const e = await w.remote.update(item("K", VALUE)).catch((x: unknown) => x);
    expect(JSON.stringify(e)).not.toContain(VALUE);
    expect(String((e as Error).message)).not.toContain(VALUE);
  });
});

describe("the role's credentials", () => {
  test("one assumption serves a whole sync, and nothing but the role's keys reaches Secrets Manager", async () => {
    const w = world();
    await w.remote.create(item("A", "a"));
    await w.remote.update(item("A", "b"));
    await w.remote.read();
    expect(w.aws.calls.filter((c) => c.action === "AssumeRole")).toHaveLength(1);
    const sent = JSON.stringify(w.aws.calls.filter((c) => c.service === "secretsmanager"));
    for (const s of [BASE.secretAccessKey, EXTERNAL_ID, "assumed-secret", "assumed-token"]) {
      expect(sent).not.toContain(s);
    }
    const regions = w.aws.calls.filter((c) => c.service === "secretsmanager").map((c) => c.region);
    expect(regions.length).toBeGreaterThan(4);
    expect(new Set(regions)).toEqual(new Set([REGION]));
  });

  test("Secrets Manager is asked in the target's region, and only there", async () => {
    const w = world();
    const remote = w.other({ region: "us-east-1", prefix: PREFIX });
    await expect(remote.read()).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("a listing and a name are checked again", () => {
  /** A fetch whose ListSecrets answer also holds `extra`, as an answer that ignored the filters would. */
  const listing =
    (extra: object[]) =>
    (real: Fetch): Fetch =>
    async (url, init) => {
      const res = await real(url, init);
      if (new Headers(init.headers).get("x-amz-target") !== "secretsmanager.ListSecrets")
        return res;
      const json = (await res.json()) as { SecretList: object[] };
      return Response.json({ ...json, SecretList: [...json.SecretList, ...extra] });
    };
  const tags = (layout: string) =>
    Object.entries(ours(layout)).map(([Key, Value]) => ({ Key, Value }));

  test("a name outside the prefix, a deleted secret or a name of another shape is never read", async () => {
    const w = world();
    await w.remote.create(item("A", "a"));
    const remote = w.through(
      listing([
        // as long as the prefix and a slash, so that cutting the prefix off it leaves a plausible shape
        { Name: "/team/other/K", Tags: tags("per-key") },
        { Name: "/team/app/Z", Tags: tags("per-key"), DeletedDate: 1 },
        { Name: "/team/app/a/b/c", Tags: tags("per-key") },
      ]),
    );
    expect((await remote.read()).map((i) => i.key)).toEqual(["A"]);
    expect(body(w, "GetSecretValue").map((b) => b.SecretId)).toEqual(["/team/app/A"]);
  });

  test("a per-scope secret is a name of one level only", async () => {
    const w = world(perScope);
    await w.remote.create(item("A", "1", "production"));
    w.aws.seedSecret("/team/app/production/extra", '{"X":"1"}', ours("per-scope"));
    expect((await w.remote.read()).map((i) => `${i.scope}:${i.key}`)).toEqual(["production:A"]);
  });

  test("a secret made between the check and the create is exists, not overwritten", async () => {
    const w = world();
    const remote = w.through(
      racing("DescribeSecret", () => {
        w.aws.seedSecret("/team/app/K", "by hand");
      }),
    );
    await expect(remote.create(item("K", "mine"))).rejects.toMatchObject({ kind: "exists" });
    expect(w.aws.secretValue("/team/app/K")).toBe("by hand");
  });

  test("the scope _ is not the scope *: a delete of it leaves the secret of *", async () => {
    const w = world(perScope);
    await w.remote.create(item("A", "1"));
    await expect(w.remote.delete({ key: "A", scope: "_" })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(object(w, "/team/app/_")).toEqual({ A: "1" });
  });

  test("a name that looks like an ARN is not deleted even when it carries our tags", async () => {
    const w = world();
    w.aws.seedSecret("/team/app/db-passwd", "v", ours("per-key"));
    await expect(w.remote.delete({ key: "db-passwd", scope: ALL_SCOPES })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(w.aws.secrets.get("/team/app/db-passwd")?.deletedAt).toBeUndefined();
    expect(sm(w, "DeleteSecret")).toHaveLength(0);
  });
});
