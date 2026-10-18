import { describe, expect, test } from "bun:test";
import {
  type AwsCreds,
  assumeRole,
  awsConfigSchema,
  awsEnv,
  awsFromEnv,
  checkAwsAssumeRole,
  externalIdSchema,
  signV4,
} from "./aws";
import { CloudError, type Fetch } from "./http";

const EXAMPLE_KEY = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const THEN = new Date("2015-08-30T12:36:00Z");

describe("signV4", () => {
  // Published by AWS: the Signature Version 4 test suite and the IAM ListUsers example.
  test("get-vanilla", () => {
    const h = signV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      body: "",
      creds: EXAMPLE_KEY,
      region: "us-east-1",
      service: "service",
      now: THEN,
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
  });

  test("the IAM ListUsers example, with a query and a header", () => {
    const h = signV4({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      creds: EXAMPLE_KEY,
      region: "us-east-1",
      service: "iam",
      now: THEN,
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  test("post-x-www-form-urlencoded: the body is part of the signature", () => {
    const sign = (body: string) =>
      signV4({
        method: "POST",
        url: "https://example.amazonaws.com/",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        creds: EXAMPLE_KEY,
        region: "us-east-1",
        service: "service",
        now: THEN,
      }).authorization;
    expect(sign("Param1=value1")).toContain(
      "Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
    );
    expect(sign("Param1=value2")).not.toBe(sign("Param1=value1"));
  });

  test("a session token is sent and signed", () => {
    const h = signV4({
      method: "POST",
      url: "https://sts.eu-west-1.amazonaws.com/",
      headers: {},
      body: "",
      creds: { ...EXAMPLE_KEY, sessionToken: "TOKEN" },
      region: "eu-west-1",
      service: "sts",
      now: THEN,
    });
    expect(h["x-amz-security-token"]).toBe("TOKEN");
    expect(h.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
  });
});

const BASE: AwsCreds = {
  accessKeyId: "AKIAPLATFORM000000",
  secretAccessKey: "base-secret-key-CANARY-0123456789",
};
const ROLE = "arn:aws:iam::111122223333:role/orch-sync";
const EXTERNAL_ID = "ext-id-CANARY-0123456789";
const TEMP = {
  accessKeyId: "ASIATEMP0000000000",
  secretAccessKey: "temp-secret-key-CANARY-0123456789",
  sessionToken: "temp-session-token-CANARY-0123456789",
};
const config = { roleArn: ROLE, region: "eu-west-1" };

interface Call {
  url: string;
  headers: Record<string, string>;
  form: URLSearchParams;
}

/** STS as far as the clients use it: AssumeRole (trust policy: the base identity and the external ID) and GetCallerIdentity. */
function fakeSts(opts: { error?: { status: number; code: string }; arn?: string } = {}) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const form = new URLSearchParams(String(init.body));
    calls.push({ url, headers, form });
    if (opts.error) {
      const { status, code } = opts.error;
      return new Response(
        `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>User: arn:aws:iam::999988887777:user/leak-me is not authorized to perform: sts:AssumeRole on ${ROLE} ${EXTERNAL_ID}</Message></Error></ErrorResponse>`,
        { status },
      );
    }
    const action = form.get("Action");
    if (action === "AssumeRole") {
      const trusted =
        headers.authorization?.includes(`Credential=${BASE.accessKeyId}/`) &&
        form.get("RoleArn") === ROLE &&
        form.get("ExternalId") === EXTERNAL_ID;
      if (!trusted)
        return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      return new Response(
        `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>${TEMP.accessKeyId}</AccessKeyId><SecretAccessKey>${TEMP.secretAccessKey}</SecretAccessKey><SessionToken>${TEMP.sessionToken}</SessionToken><Expiration>2030-01-01T00:15:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`,
      );
    }
    if (action === "GetCallerIdentity") {
      if (headers["x-amz-security-token"] !== TEMP.sessionToken) {
        return new Response("<Error><Code>InvalidClientTokenId</Code></Error>", { status: 403 });
      }
      return new Response(
        `<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>${opts.arn ?? "arn:aws:sts::111122223333:assumed-role/orch-sync/orch"}</Arn></GetCallerIdentityResult></GetCallerIdentityResponse>`,
      );
    }
    return new Response("", { status: 400 });
  };
  return { fetch, calls };
}

describe("assumeRole", () => {
  test("asks the regional STS, signed by the platform's identity, with the external ID", async () => {
    const sts = fakeSts();
    const got = await assumeRole({ fetch: sts.fetch }, BASE, {
      ...config,
      externalId: EXTERNAL_ID,
    });
    expect(got).toMatchObject(TEMP);
    expect(got.expiresAt.toISOString()).toBe("2030-01-01T00:15:00.000Z");
    const [call] = sts.calls;
    expect(call?.url).toBe("https://sts.eu-west-1.amazonaws.com/");
    expect(call?.headers.authorization).toContain(`Credential=${BASE.accessKeyId}/`);
    expect(call?.headers.authorization).toContain("/eu-west-1/sts/aws4_request");
    expect(Object.fromEntries(call?.form ?? [])).toMatchObject({
      Action: "AssumeRole",
      RoleArn: ROLE,
      ExternalId: EXTERNAL_ID,
      RoleSessionName: "orch",
      DurationSeconds: "900",
    });
    // the base secret is used to sign and is never sent
    expect(JSON.stringify(call)).not.toContain(BASE.secretAccessKey);
  });

  test("an answer that is not credentials is refused", async () => {
    const f: Fetch = async () => new Response("<AssumeRoleResponse></AssumeRoleResponse>");
    const e = await assumeRole({ fetch: f }, BASE, { ...config, externalId: EXTERNAL_ID }).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(CloudError);
    expect((e as CloudError).reason).toBe("unexpected");
  });
});

describe("checkAwsAssumeRole", () => {
  test("assumes the role and says who it became, and that is all it says", async () => {
    const sts = fakeSts();
    const r = await checkAwsAssumeRole(config, EXTERNAL_ID, { fetch: sts.fetch, base: BASE });
    expect(r).toEqual({
      ok: true,
      summary: "Assumed arn:aws:sts::111122223333:assumed-role/orch-sync/orch",
    });
    expect(sts.calls.map((c) => c.form.get("Action"))).toEqual(["AssumeRole", "GetCallerIdentity"]);
    const text = JSON.stringify(r);
    for (const s of [BASE.secretAccessKey, TEMP.secretAccessKey, TEMP.sessionToken, EXTERNAL_ID]) {
      expect(text).not.toContain(s);
    }
  });

  test("a refusal of the identity call, made with the role just assumed, does not blame the platform's identity", async () => {
    const sts = fakeSts();
    const f: Fetch = async (url, init) =>
      new URLSearchParams(String(init.body)).get("Action") === "GetCallerIdentity"
        ? new Response("<Error><Code>ExpiredToken</Code></Error>", { status: 403 })
        : sts.fetch(url, init);
    const r = await checkAwsAssumeRole(config, EXTERNAL_ID, { fetch: f, base: BASE });
    expect(r).toMatchObject({ ok: false, reason: "unexpected" });
    expect(JSON.stringify(r)).not.toContain("platform's own identity");
  });

  test("a wrong external ID or a role that does not trust the platform is `forbidden`", async () => {
    const r = await checkAwsAssumeRole(config, "another-external-id-0000", {
      fetch: fakeSts().fetch,
      base: BASE,
    });
    expect(r).toMatchObject({ ok: false, reason: "forbidden" });
    expect(r).toMatchObject({ message: expect.stringContaining("trust policy") });
  });

  test("each way AWS can say no is an answer in fixed words, never AWS's own text", async () => {
    const cases = [
      [403, "AccessDenied", "forbidden"],
      [403, "InvalidClientTokenId", "unauthorized"],
      [403, "SignatureDoesNotMatch", "unauthorized"],
      [403, "ExpiredToken", "unauthorized"],
      [400, "ValidationError", "invalid"],
      [400, "Throttling", "rate_limited"],
      [503, "ServiceUnavailable", "server"],
      [418, "Weird", "invalid"],
    ] as const;
    for (const [status, code, reason] of cases) {
      const r = await checkAwsAssumeRole(config, EXTERNAL_ID, {
        fetch: fakeSts({ error: { status, code } }).fetch,
        base: BASE,
      });
      expect([code, r]).toMatchObject([code, { ok: false, reason }]);
      const text = JSON.stringify(r);
      for (const s of ["leak-me", "999988887777", EXTERNAL_ID, ROLE, BASE.secretAccessKey]) {
        expect(text).not.toContain(s);
      }
    }
  });

  test("an unreachable or slow STS is `network` or `timeout`", async () => {
    const down: Fetch = async () => {
      throw new Error(`boom ${EXTERNAL_ID}`);
    };
    expect(
      await checkAwsAssumeRole(config, EXTERNAL_ID, { fetch: down, base: BASE }),
    ).toMatchObject({
      ok: false,
      reason: "network",
    });
    const slow: Fetch = (_u, init) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    expect(
      await checkAwsAssumeRole(config, EXTERNAL_ID, { fetch: slow, base: BASE, timeoutMs: 20 }),
    ).toMatchObject({ ok: false, reason: "timeout" });
  });

  test("a caller identity that is not an assumed role of the account is not believed", async () => {
    const r = await checkAwsAssumeRole(config, EXTERNAL_ID, {
      fetch: fakeSts({ arn: "arn:aws:iam::999988887777:root" }).fetch,
      base: BASE,
    });
    expect(r).toMatchObject({ ok: false, reason: "unexpected" });
  });
});

describe("what a connection is allowed to say", () => {
  test("a role ARN of the aws partition and a region", () => {
    expect(awsConfigSchema.parse(config)).toEqual(config);
    const bad = [
      { ...config, roleArn: "arn:aws:iam::111122223333:user/orch" },
      { ...config, roleArn: "arn:aws:iam::1111:role/orch" },
      { ...config, roleArn: "arn:aws-cn:iam::111122223333:role/orch" },
      { ...config, roleArn: "arn:aws:iam::111122223333:role/" },
      { ...config, region: "Europe" },
      { ...config, region: "eu-west-1.evil.test/" },
      { ...config, region: "" },
      { roleArn: ROLE },
      { ...config, endpoint: "https://evil.test" },
    ];
    for (const b of bad) expect(awsConfigSchema.safeParse(b).success).toBe(false);
  });

  test("an external ID is long enough to be unguessable and within AWS's alphabet", () => {
    expect(externalIdSchema.safeParse("a".repeat(16)).success).toBe(true);
    expect(externalIdSchema.safeParse("abc:def/ghi+jkl=mno,pq.r@s_t-u").success).toBe(true);
    for (const bad of [
      "",
      "short",
      "a".repeat(1225),
      "has space in it 0123456789",
      "ünïcode-0123456789abc",
    ]) {
      expect(externalIdSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("awsFromEnv", () => {
  test("the platform's own identity is the standard variables, or nothing", () => {
    expect(
      awsFromEnv({
        AWS_ACCESS_KEY_ID: "AKIA1",
        AWS_SECRET_ACCESS_KEY: "s",
        AWS_SESSION_TOKEN: "t",
      }),
    ).toEqual({ accessKeyId: "AKIA1", secretAccessKey: "s", sessionToken: "t" });
    expect(awsFromEnv({ AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "s" })).toEqual({
      accessKeyId: "AKIA1",
      secretAccessKey: "s",
    });
    expect(awsFromEnv({ AWS_ACCESS_KEY_ID: "AKIA1" })).toBeUndefined();
    expect(awsFromEnv({})).toBeUndefined();
  });

  test("an empty variable is an unset one, and does not stop the app from starting", () => {
    const empty = { AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_SESSION_TOKEN: "" };
    expect(awsEnv.safeParse(empty).success).toBe(true);
    expect(awsFromEnv(empty)).toBeUndefined();
    expect(
      awsFromEnv({ ...empty, AWS_ACCESS_KEY_ID: "AKIA1", AWS_SECRET_ACCESS_KEY: "s" }),
    ).toEqual({ accessKeyId: "AKIA1", secretAccessKey: "s" });
  });
});
