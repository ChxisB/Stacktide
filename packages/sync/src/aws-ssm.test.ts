import { describe, expect, test } from "bun:test";
import type { AwsCreds } from "./aws";
import { AwsApiError, assumedSession, awsJson } from "./aws-json";
import { AWS_SSM, awsSsmAdapter, OWNER_TAG, parseAwsSsmConfig } from "./aws-ssm";
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
const config = { region: REGION, prefix: PREFIX };
const LEAK = "aws-leak-CANARY-9d41";
const VALUE = "value-CANARY-5b2e";

const item = (key: string, value: string, scope = ALL_SCOPES, secret = false): ItemInput => ({
  key,
  scope,
  value,
  secret,
  file: false,
});

/** An account with Parameter Store, the role, and an adapter that reaches it the way the platform does. */
function world(opts: Partial<FakeAwsOptions> = {}, cfg: Record<string, unknown> = config) {
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
  const deps = { fetch: aws.fetch, now: () => clock };
  const session = assumedSession(deps, BASE, {
    roleArn: ROLE,
    region: REGION,
    externalId: EXTERNAL_ID,
  });
  const adapter = awsSsmAdapter(session, deps);
  return {
    aws,
    adapter,
    remote: adapter.connect(adapter.validate(cfg)),
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}
const actions = (w: ReturnType<typeof world>, action: string) =>
  w.aws.calls.filter((c) => c.service === "ssm" && c.action === action);

runAdapterConformance(
  "aws-ssm (contract fake)",
  async () => {
    const w = world();
    return { adapter: w.adapter, config };
  },
  {
    refused: [
      { item: item("K", ""), kind: "invalid" },
      { item: item("K", "x".repeat(4097)), kind: "invalid" },
      { item: item("K", "a {{ssm:other}} b"), kind: "invalid" },
      { item: item("has space", "v"), kind: "invalid" },
      { item: item("a/b", "v"), kind: "invalid" },
      { item: item("..", "v"), kind: "invalid" },
      { item: item("K", "v", "prod*"), kind: "invalid" },
      { item: item("K", "v", "a/b"), kind: "invalid" },
    ],
  },
);

describe("the config", () => {
  test("a region and a prefix, and optionally a KMS key and protected", () => {
    expect(parseAwsSsmConfig(config)).toEqual(config);
    const full = { ...config, kmsKeyId: "alias/orch", protected: true };
    expect(parseAwsSsmConfig(full)).toEqual(full);
    expect(
      parseAwsSsmConfig({ ...config, kmsKeyId: "arn:aws:kms:eu-west-1:111122223333:key/1234" }),
    ).toBeTruthy();
    const bad: unknown[] = [
      {},
      { region: REGION },
      { prefix: PREFIX },
      { ...config, prefix: "team/app" },
      { ...config, prefix: "/" },
      { ...config, prefix: "/team/app/" },
      { ...config, prefix: "/team//app" },
      { ...config, prefix: "/team/../app" },
      { ...config, prefix: "/team/./app" },
      { ...config, prefix: "/aws/app" },
      { ...config, prefix: "/SSM-things/app" },
      { ...config, prefix: "/team/*" },
      { ...config, prefix: "/a/b/c/d/e/f/g/h/i/j/k/l/m/n" },
      { ...config, prefix: `/${"x".repeat(61)}` },
      { ...config, region: "eu" },
      { ...config, region: "eu-west-1.evil.test/" },
      { ...config, kmsKeyId: "has space" },
      { ...config, protected: "yes" },
      { ...config, endpoint: "https://evil.test" },
      { ...config, token: VALUE },
    ];
    for (const b of bad) {
      const e = (() => {
        try {
          parseAwsSsmConfig(b);
        } catch (x) {
          return x;
        }
      })();
      expect([b, e instanceof SyncError && e.kind]).toEqual([b, "invalid_config"]);
      expect((e as SyncError).message).not.toContain(VALUE);
    }
    // 13 levels is the most that leaves room for a scope and a key
    const deep = `/${Array.from({ length: 13 }, (_, i) => `l${i}`).join("/")}`;
    expect(parseAwsSsmConfig({ ...config, prefix: deep }).prefix).toBe(deep);
  });
});

describe("how items become parameters", () => {
  test("the adapter is the aws-ssm target type", () => {
    expect(world().adapter.type).toBe(AWS_SSM);
  });

  test("a key is a parameter under the prefix, a scope is a level between, and every one is tagged", async () => {
    const w = world();
    await w.remote.create(item("API_URL", "https://example.test"));
    await w.remote.create(item("DB_PASSWORD", VALUE, "production", true));
    expect([...w.aws.params.keys()].sort()).toEqual([
      "/team/app/API_URL",
      "/team/app/production/DB_PASSWORD",
    ]);
    expect(w.aws.params.get("/team/app/API_URL")).toMatchObject({
      type: "String",
      value: "https://example.test",
      tags: { [OWNER_TAG]: PREFIX },
    });
    expect(w.aws.params.get("/team/app/production/DB_PASSWORD")).toMatchObject({
      type: "SecureString",
      value: VALUE,
    });
    // creating never overwrites, and tags go with the first write
    const puts = actions(w, "PutParameter").map((c) => c.body as Record<string, unknown>);
    expect(puts).toHaveLength(2);
    for (const p of puts) {
      expect(p.Overwrite).toBeUndefined();
      expect(p.Tags).toEqual([{ Key: OWNER_TAG, Value: PREFIX }]);
    }
    expect(await w.remote.read()).toEqual([
      { key: "API_URL", scope: "*", value: "https://example.test", secret: false, file: false },
      { key: "DB_PASSWORD", scope: "production", value: VALUE, secret: true, file: false },
    ]);
  });

  test("the KMS key is named for a secret and for nothing else", async () => {
    const w = world({}, { ...config, kmsKeyId: "alias/orch" });
    await w.remote.create(item("PLAIN", "p"));
    await w.remote.create(item("SECRET", "s-value", ALL_SCOPES, true));
    const [plain, secret] = actions(w, "PutParameter").map(
      (c) => c.body as Record<string, unknown>,
    );
    expect(plain?.KeyId).toBeUndefined();
    expect(secret).toMatchObject({ Type: "SecureString", KeyId: "alias/orch" });
    // turning a secret plain does not send a key; turning one secret does
    await w.remote.update(item("PLAIN", "p2", ALL_SCOPES, true));
    await w.remote.update(item("SECRET", "s-value", ALL_SCOPES, false));
    const updates = actions(w, "PutParameter")
      .slice(2)
      .map((c) => c.body as Record<string, unknown>);
    expect(updates[0]).toMatchObject({
      Type: "SecureString",
      KeyId: "alias/orch",
      Overwrite: true,
    });
    expect(updates[1]).toMatchObject({ Type: "String", Overwrite: true });
    expect(updates[1]?.KeyId).toBeUndefined();
  });

  test("an update overwrites only after it saw the tag, and keeps the parameter's tags", async () => {
    const w = world();
    await w.remote.create(item("K", "one"));
    await w.remote.update(item("K", "two"));
    expect(w.aws.calls.filter((c) => c.service === "ssm").map((c) => c.action)).toEqual([
      "PutParameter",
      "ListTagsForResource",
      "PutParameter",
    ]);
    expect(w.aws.params.get("/team/app/K")).toMatchObject({
      value: "two",
      version: 2,
      tags: { [OWNER_TAG]: PREFIX },
    });
    const last = actions(w, "PutParameter")[1]?.body as Record<string, unknown>;
    expect(last.Overwrite).toBe(true);
    expect(last.Tags).toBeUndefined();
  });

  test("the limit is 4096 bytes, not characters", async () => {
    const w = world();
    // 1365 three-byte characters are 4095 bytes; 1366 are 4098
    await w.remote.create(item("OK", "€".repeat(1365)));
    const before = w.aws.calls.length;
    await expect(w.remote.create(item("TOO_BIG", "€".repeat(1366)))).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(w.aws.calls).toHaveLength(before);
  });

  test("a value of 4096 characters is kept, one more is refused before AWS is asked", async () => {
    const w = world();
    const big = "x".repeat(4096);
    await w.remote.create(item("BIG", big));
    expect((await w.remote.read())[0]?.value).toBe(big);
    const before = w.aws.calls.length;
    await expect(w.remote.create(item("BIGGER", `${big}x`))).rejects.toMatchObject({
      kind: "invalid",
    });
    expect(w.aws.calls).toHaveLength(before);
  });
});

describe("what the platform did not make is never touched", () => {
  const seeded = () => {
    const w = world();
    w.aws.seed("/team/app/MANUAL", "by hand");
    w.aws.seed("/team/app/ELSEWHERE", "another prefix's", { tags: { [OWNER_TAG]: "/team" } });
    w.aws.seed("/team/app/prod/DEEP", "too deep for us", { tags: { [OWNER_TAG]: PREFIX } });
    w.aws.seed("/team/app/prod/deeper/KEY", "much too deep", { tags: { [OWNER_TAG]: PREFIX } });
    w.aws.seed("/team/other/KEY", "outside", { tags: { [OWNER_TAG]: PREFIX } });
    w.aws.seed("/team/app/RETAGGED", "tag of someone else", { tags: { team: PREFIX } });
    return w;
  };
  const untouched = (w: ReturnType<typeof world>) =>
    [...w.aws.params].filter(([name]) => name !== "/team/app/OURS");

  test("a read lists only parameters tagged for this prefix, in a place an item can be", async () => {
    const w = seeded();
    await w.remote.create(item("OURS", "mine"));
    expect((await w.remote.read()).map((i) => `${i.key}@${i.scope}`)).toEqual([
      "DEEP@prod",
      "OURS@*",
    ]);
  });

  test("create finds a parameter that is there, and says how to take it over, without changing it", async () => {
    const w = seeded();
    const before = structuredClone(untouched(w));
    for (const key of ["MANUAL", "ELSEWHERE", "RETAGGED"]) {
      const e = await w.remote.create(item(key, VALUE)).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SyncError);
      expect((e as SyncError).kind).toBe("exists");
      expect((e as SyncError).message).toContain(`${OWNER_TAG}=${PREFIX}`);
      expect((e as SyncError).message).not.toContain(VALUE);
    }
    expect(untouched(w)).toEqual(before);
  });

  test("update and delete say not_found, and send no write", async () => {
    const w = seeded();
    const before = structuredClone(untouched(w));
    for (const key of ["MANUAL", "ELSEWHERE", "RETAGGED"]) {
      await expect(w.remote.update(item(key, VALUE))).rejects.toMatchObject({ kind: "not_found" });
      await expect(w.remote.delete({ key, scope: ALL_SCOPES })).rejects.toMatchObject({
        kind: "not_found",
      });
    }
    // a place no item can be in is not there either, and AWS is not asked about it
    await expect(w.remote.delete({ key: "KEY", scope: "prod/deeper" })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(untouched(w)).toEqual(before);
    expect(actions(w, "DeleteParameter")).toEqual([]);
    expect(actions(w, "PutParameter")).toEqual([]);
  });

  test("targets with overlapping prefixes do not see or change each other's parameters", async () => {
    const outer = world();
    const inner = awsSsmAdapter(
      assumedSession({ fetch: outer.aws.fetch }, BASE, {
        roleArn: ROLE,
        region: REGION,
        externalId: EXTERNAL_ID,
      }),
      { fetch: outer.aws.fetch },
    ).connect({ region: REGION, prefix: "/team/app/prod" });
    // the same parameter, as `X` in scope `prod` of the outer target and as `X` of the inner one
    await outer.remote.create(item("X", "outer", "prod"));
    await expect(inner.create(item("X", VALUE))).rejects.toMatchObject({ kind: "exists" });
    expect(await inner.read()).toEqual([]);
    await expect(inner.update(item("X", VALUE))).rejects.toMatchObject({ kind: "not_found" });
    await expect(inner.delete({ key: "X", scope: ALL_SCOPES })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect((await outer.remote.read()).map((i) => i.value)).toEqual(["outer"]);
    // and the inner target's own parameter is no part of the outer one's view
    await inner.create(item("Y", "inner"));
    expect((await outer.remote.read()).map((i) => i.key)).toEqual(["X"]);
    expect((await inner.read()).map((i) => i.key)).toEqual(["Y"]);
  });

  test("the platform deletes its own parameter and leaves the rest", async () => {
    const w = seeded();
    const before = structuredClone(untouched(w));
    await w.remote.create(item("OURS", "mine"));
    await w.remote.delete({ key: "OURS", scope: ALL_SCOPES });
    expect(untouched(w)).toEqual(before);
    expect(w.aws.params.has("/team/app/OURS")).toBe(false);
  });
});

describe("reading", () => {
  test("follows DescribeParameters pages, asks for 10 names at a time, with decryption", async () => {
    const w = world();
    const keys = Array.from({ length: 25 }, (_, i) => `K${String(i).padStart(2, "0")}`);
    for (const k of keys) await w.remote.create(item(k, `v-${k}`, ALL_SCOPES, k === "K03"));
    w.aws.calls.length = 0;
    const read = await w.remote.read();
    expect(read.map((i) => i.key)).toEqual(keys);
    expect(read[3]).toMatchObject({ key: "K03", value: "v-K03", secret: true });
    // pageSize 3 in the fake: 9 pages
    expect(actions(w, "DescribeParameters")).toHaveLength(9);
    const gets = actions(w, "GetParameters").map((c) => c.body as Record<string, unknown>);
    expect(gets.map((g) => (g.Names as string[]).length)).toEqual([10, 10, 5]);
    for (const g of gets) expect(g.WithDecryption).toBe(true);
    expect(actions(w, "DescribeParameters")[0]?.body).toEqual({
      ParameterFilters: [
        { Key: "Path", Option: "Recursive", Values: [PREFIX] },
        { Key: `tag:${OWNER_TAG}`, Values: [PREFIX] },
      ],
      MaxResults: 50,
    });
  });

  test("a parameter deleted between the listing and the read is skipped", async () => {
    const w = world();
    await w.remote.create(item("A", "a"));
    await w.remote.create(item("B", "b"));
    const racing: Fetch = async (url, init) => {
      const res = await w.aws.fetch(url, init);
      if (new Headers(init.headers).get("x-amz-target") === "AmazonSSM.DescribeParameters") {
        w.aws.params.delete("/team/app/B");
      }
      return res;
    };
    const deps = { fetch: racing };
    const remote = awsSsmAdapter(
      assumedSession(deps, BASE, { roleArn: ROLE, region: REGION, externalId: EXTERNAL_ID }),
      deps,
    ).connect(config);
    expect((await remote.read()).map((i) => i.key)).toEqual(["A"]);
  });

  test("a parameter deleted between the ownership check and its delete is already gone", async () => {
    const w = world();
    await w.remote.create(item("GONE", "g"));
    const racing: Fetch = async (url, init) => {
      const res = await w.aws.fetch(url, init);
      if (new Headers(init.headers).get("x-amz-target") === "AmazonSSM.ListTagsForResource") {
        w.aws.params.delete("/team/app/GONE");
      }
      return res;
    };
    const deps = { fetch: racing };
    const remote = awsSsmAdapter(
      assumedSession(deps, BASE, { roleArn: ROLE, region: REGION, externalId: EXTERNAL_ID }),
      deps,
    ).connect(config);
    await expect(remote.delete({ key: "GONE", scope: ALL_SCOPES })).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  test("an answer that is not what SSM says is a failure, not an empty target", async () => {
    const w = world();
    const wrong: Fetch = async (url, init) =>
      new Headers(init.headers).get("x-amz-target") === "AmazonSSM.DescribeParameters"
        ? Response.json({ Parameters: "none" })
        : w.aws.fetch(url, init);
    const deps = { fetch: wrong };
    const remote = awsSsmAdapter(
      assumedSession(deps, BASE, { roleArn: ROLE, region: REGION, externalId: EXTERNAL_ID }),
      deps,
    ).connect(config);
    await expect(remote.read()).rejects.toMatchObject({
      kind: "failed",
      message: "reading the parameters: AWS answered something unexpected",
    });
  });
});

describe("failures", () => {
  const ops: [string, (w: ReturnType<typeof world>) => Promise<unknown>][] = [
    ["DescribeParameters", (w) => w.remote.read()],
    ["PutParameter", (w) => w.remote.create(item("NEW", VALUE))],
    ["ListTagsForResource", (w) => w.remote.update(item("K", VALUE))],
    ["PutParameter", (w) => w.remote.update(item("K", VALUE))],
    ["DeleteParameter", (w) => w.remote.delete({ key: "K", scope: ALL_SCOPES })],
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

  test("a role that does not trust the platform fails the read in fixed words and shows no credential", async () => {
    // the role's trust policy wants another external ID than the one the platform holds
    const w = world({ externalId: "another-external-id-0000" });
    const e = await w.remote.read().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SyncError);
    expect((e as SyncError).message).toBe(
      "reading the parameters: AWS could not be asked (forbidden)",
    );
    expect(actions(w, "DescribeParameters")).toEqual([]);
  });

  test("a platform identity that is not known is `unauthorized`", async () => {
    const w = world();
    const deps = { fetch: w.aws.fetch };
    const remote = awsSsmAdapter(
      assumedSession(
        deps,
        { ...BASE, accessKeyId: "AKIAUNKNOWN0000000" },
        {
          roleArn: ROLE,
          region: REGION,
          externalId: EXTERNAL_ID,
        },
      ),
      deps,
    ).connect(config);
    await expect(remote.read()).rejects.toMatchObject({
      kind: "failed",
      message: "reading the parameters: AWS could not be asked (unauthorized)",
    });
  });

  test("a network failure carries nothing of the cause", async () => {
    const deps = {
      fetch: (async () => {
        throw new Error(`connect to ${VALUE} failed`);
      }) as Fetch,
    };
    const remote = awsSsmAdapter(
      assumedSession(deps, BASE, { roleArn: ROLE, region: REGION, externalId: EXTERNAL_ID }),
      deps,
    ).connect(config);
    const e = await remote.create(item("K", VALUE)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SyncError);
    expect((e as SyncError).message).not.toContain(VALUE);
  });
});

describe("the role's credentials", () => {
  test("are asked for once, reused, and asked for again before they lapse", async () => {
    const w = world();
    await w.remote.create(item("A", "a"));
    await w.remote.read();
    const assumes = () => w.aws.calls.filter((c) => c.action === "AssumeRole").length;
    expect(assumes()).toBe(1);
    // 14 minutes in: the 15-minute credentials are good for a minute more, which is too close
    w.advance(14 * 60_000);
    await w.remote.read();
    expect(assumes()).toBe(2);
    // and the new ones are used, so the fake (which expires the old) never refuses
    w.advance(10 * 60_000);
    expect((await w.remote.read()).map((i) => i.key)).toEqual(["A"]);
    expect(assumes()).toBe(2);
  });

  test("callers that arrive together share one request for them", async () => {
    const w = world();
    await Promise.all([
      w.remote.read(),
      w.remote.read(),
      w.remote.read(),
      w.remote.create(item("A", "a")),
    ]);
    const assumes = () => w.aws.calls.filter((c) => c.action === "AssumeRole").length;
    expect(assumes()).toBe(1);
    // and once they lapse, a burst asks once more, not once each
    w.advance(14 * 60_000);
    await Promise.all([w.remote.read(), w.remote.read(), w.remote.read()]);
    expect(assumes()).toBe(2);
  });

  test("a failed assumption is not remembered", async () => {
    const w = world();
    let down = true;
    const flaky: Fetch = async (url, init) => {
      if (down) throw new Error("offline");
      return w.aws.fetch(url, init);
    };
    const deps = { fetch: flaky };
    const remote = awsSsmAdapter(
      assumedSession(deps, BASE, { roleArn: ROLE, region: REGION, externalId: EXTERNAL_ID }),
      deps,
    ).connect(config);
    await expect(remote.read()).rejects.toMatchObject({ kind: "failed" });
    down = false;
    expect(await remote.read()).toEqual([]);
  });

  test("the platform's secret key, the external ID and the role's keys are never sent to SSM", async () => {
    const w = world();
    await w.remote.create(item("A", "a", ALL_SCOPES, true));
    await w.remote.read();
    const ssmCalls = JSON.stringify(w.aws.calls.filter((c) => c.service === "ssm"));
    for (const s of [BASE.secretAccessKey, EXTERNAL_ID, "assumed-secret", "assumed-token"]) {
      expect(ssmCalls).not.toContain(s);
    }
  });

  test("SSM is asked in the target's region, and only there", async () => {
    const w = world();
    await w.remote.create(item("A", "a"));
    expect(w.aws.calls.filter((c) => c.service === "ssm").map((c) => c.region)).toEqual([REGION]);
    const elsewhere = world();
    const deps = { fetch: elsewhere.aws.fetch };
    const remote = awsSsmAdapter(
      assumedSession(deps, BASE, { roleArn: ROLE, region: REGION, externalId: EXTERNAL_ID }),
      deps,
    ).connect({ region: "us-east-1", prefix: PREFIX });
    await expect(remote.read()).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("awsJson", () => {
  const stub =
    (status: number, body: string): Fetch =>
    async () =>
      new Response(body, { status });
  const call = (f: Fetch) =>
    awsJson(
      { fetch: f },
      BASE,
      { service: "ssm", target: "AmazonSSM" },
      REGION,
      "GetParameters",
      {},
    );

  test("posts a signed JSON 1.1 request to the service in the region", async () => {
    let seen: { url: string; headers: Headers; body: string } | undefined;
    const f: Fetch = async (url, init) => {
      seen = { url, headers: new Headers(init.headers), body: String(init.body) };
      return Response.json({ ok: true });
    };
    expect(
      await awsJson(
        { fetch: f, now: () => new Date("2030-01-01T00:00:00Z") },
        { ...BASE, sessionToken: "tok-CANARY" },
        { service: "ssm", target: "AmazonSSM" },
        REGION,
        "PutParameter",
        { Name: "/x" },
      ),
    ).toEqual({ ok: true });
    expect(seen?.url).toBe("https://ssm.eu-west-1.amazonaws.com/");
    expect(seen?.headers.get("x-amz-target")).toBe("AmazonSSM.PutParameter");
    expect(seen?.headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(seen?.headers.get("x-amz-security-token")).toBe("tok-CANARY");
    expect(seen?.headers.get("authorization")).toContain(
      `Credential=${BASE.accessKeyId}/20300101/eu-west-1/ssm/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target`,
    );
    expect(seen?.headers.get("authorization")).not.toContain(BASE.secretAccessKey);
    expect(seen?.body).toBe('{"Name":"/x"}');
  });

  test("an error is its reason and a name AWS defines, whichever way the name is written", async () => {
    const cases: [number, string, string, string][] = [
      [
        400,
        `{"__type":"ParameterAlreadyExists","message":"${LEAK}"}`,
        "ParameterAlreadyExists",
        "invalid",
      ],
      [400, `{"__type":"com.amazonaws.ssm#ParameterNotFound"}`, "ParameterNotFound", "invalid"],
      [
        400,
        `{"__type":"AccessDeniedException:http://internal.amazon.com/coral/"}`,
        "AccessDeniedException",
        "forbidden",
      ],
      [400, `{"__type":"ThrottlingException"}`, "ThrottlingException", "rate_limited"],
      [400, `{"__type":"TooManyUpdates"}`, "TooManyUpdates", "rate_limited"],
      [
        400,
        `{"__type":"UnrecognizedClientException"}`,
        "UnrecognizedClientException",
        "unauthorized",
      ],
      [400, `{"__type":"ExpiredTokenException"}`, "ExpiredTokenException", "unauthorized"],
      [403, `{"__type":"InvalidSignatureException"}`, "InvalidSignatureException", "unauthorized"],
      [500, `{"__type":"InternalServerError"}`, "InternalServerError", "server"],
      [503, "<html>", "", "server"],
      [400, `{"__type":"has spaces and ${LEAK}"}`, "", "invalid"],
      [400, `{"__type":42}`, "", "invalid"],
      [404, "", "", "not_found"],
    ];
    for (const [status, body, code, reason] of cases) {
      const e = await call(stub(status, body)).catch((x: unknown) => x);
      expect([body, e instanceof AwsApiError && [e.code, e.reason]]).toEqual([
        body,
        [code, reason],
      ]);
      expect((e as Error).message).not.toContain(LEAK);
    }
  });

  test("an answer that is not JSON is unexpected, an empty one is `{}`", async () => {
    await expect(call(stub(200, "<html>"))).rejects.toMatchObject({ reason: "unexpected" });
    expect(await call(stub(200, ""))).toEqual({});
  });
});
