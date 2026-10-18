import { describe, expect, test } from "bun:test";
import type { AwsCreds } from "./aws";
import { assumedSession } from "./aws-json";
import { fakeAws } from "./fake-aws";
import { fakeVault } from "./fake-vault";
import type { Fetch } from "./http";
import {
  awsReferenceReader,
  isReference,
  MAX_REFERENCE_VALUE,
  parseReference,
  REFERENCE_WHY,
  type Reference,
  ReferenceFailure,
  type ReferenceReader,
  vaultReferenceReader,
} from "./references";
import type { VaultConfig } from "./vault";

const ADDRESS = "https://vault.example.test:8200";
const SECRET_ID = "secret-id-CANARY-0123456789";
const LEAK = "store-leak-CANARY-4c7d";
const VALUE = "value-CANARY-8e21";
const vaultConnection: VaultConfig = {
  address: ADDRESS,
  roleId: "role-id-1234",
  authMount: "approle",
  kvMount: "kv",
  prefix: "app/prod",
};
const BASE: AwsCreds = {
  accessKeyId: "AKIAPLATFORM000000",
  secretAccessKey: "base-secret-key-CANARY-0123456789",
};
const ROLE = "arn:aws:iam::111122223333:role/orch-sync";
const EXTERNAL_ID = "ext-id-CANARY-0123456789";
const REGION = "eu-west-1";

const vault = (path: string, field: string): Reference => ({
  kind: "vault",
  connection: "prod-vault",
  path,
  field,
});
const aws = (secret: string, field?: string): Reference => ({
  kind: "aws-sm",
  connection: "prod-aws",
  secret,
  ...(field === undefined ? {} : { field }),
});

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ReferenceFailure) return e;
    throw e;
  }
  throw new Error("expected a ReferenceFailure");
};

describe("the grammar", () => {
  test("a Vault reference is a connection, a path under its prefix and a field", () => {
    expect(parseReference("vault://prod-vault/app/db#password")).toEqual(
      vault("app/db", "password"),
    );
    expect(parseReference("vault://prod-vault/x#a.b-c_1")).toEqual(vault("x", "a.b-c_1"));
  });

  test("the connection is percent-decoded, so a name with a space can be written", () => {
    expect(parseReference("vault://my%20vault/x#f")).toEqual({
      kind: "vault",
      connection: "my vault",
      path: "x",
      field: "f",
    });
  });

  test("a connection name of 100 characters is as long as one may be", () => {
    const name = "a".repeat(100);
    expect(parseReference(`vault://${name}/a#f`)).toMatchObject({ connection: name });
  });

  test("an encoded slash is part of the connection's name, not a path", () => {
    expect(parseReference("vault://a%2Fb/x#f")).toEqual({
      kind: "vault",
      connection: "a/b",
      path: "x",
      field: "f",
    });
  });

  test("a Secrets Manager reference is a connection and a secret name, with an optional JSON field", () => {
    expect(parseReference("aws-sm://prod-aws/prod/db/password")).toEqual(aws("prod/db/password"));
    expect(parseReference("aws-sm://prod-aws/prod/db#password")).toEqual(
      aws("prod/db", "password"),
    );
  });

  test("a name that starts with a slash is written with two", () => {
    expect(parseReference("aws-sm://prod-aws//prod/db")).toEqual(aws("/prod/db"));
  });

  test("isReference is the scheme, exactly", () => {
    expect(isReference("vault://x")).toBe(true);
    expect(isReference("aws-sm://x")).toBe(true);
    for (const v of [
      "",
      "hunter2",
      "https://vault://x",
      " vault://x",
      "VAULT://x",
      "vault:/x",
      "aws-ssm://x",
    ]) {
      expect(isReference(v)).toBe(false);
    }
  });

  test.each([
    ["vault without a field", "vault://c/app/db"],
    ["vault with an empty field", "vault://c/app/db#"],
    ["vault without a path", "vault://c#f"],
    ["vault with an empty path", "vault://c/#f"],
    ["vault without a connection", "vault:///a#f"],
    ["a dot segment", "vault://c/a/../b#f"],
    ["a single dot segment", "vault://c/./b#f"],
    ["a leading dot", "vault://c/.hidden#f"],
    ["an empty segment", "vault://c/a//b#f"],
    ["a trailing slash", "vault://c/a/#f"],
    ["a space in the path", "vault://c/a b#f"],
    ["a query", "vault://c/a?x=1#f"],
    ["a second field", "vault://c/a#f#g"],
    ["a newline after it", "vault://c/a#f\n"],
    ["a space after it", "vault://c/a#f "],
    ["nine segments", `vault://c/${Array(9).fill("a").join("/")}#f`],
    ["a bad percent escape", "vault://c%zz/a#f"],
    ["an over-long decoded name", `vault://${"%41".repeat(101)}/a#f`],
    ["a connection name of 101 characters", `vault://${"a".repeat(101)}/a#f`],
    ["something before a vault reference", "x vault://c/a#f"],
    ["something before an aws reference", "x aws-sm://c/a"],
    ["aws without a connection", "aws-sm:///a"],
    ["aws without a name", "aws-sm://c"],
    ["aws with an empty name", "aws-sm://c/"],
    ["aws with a space", "aws-sm://c/a b"],
    ["aws with an empty field", "aws-sm://c/a#"],
    ["aws with a query", "aws-sm://c/a?x"],
    ["aws with a second field", "aws-sm://c/a#f#g"],
    ["aws with an over-long name", `aws-sm://c/${"a".repeat(513)}`],
  ])("%s is malformed", (_why, text) => {
    expect(() => parseReference(text)).toThrow(ReferenceFailure);
    try {
      parseReference(text);
    } catch (e) {
      expect((e as ReferenceFailure).reason).toBe("malformed");
      expect((e as ReferenceFailure).message).not.toContain(text);
    }
  });

  test("something that is not a reference is malformed too", () => {
    expect(() => parseReference("hunter2")).toThrow(ReferenceFailure);
  });

  test("every reason has words, and none of them quotes a value", () => {
    for (const why of Object.values(REFERENCE_WHY)) expect(why).toMatch(/^[a-z]/);
  });
});

/** A Vault with one secret at `kv/data/app/prod/app/db`. */
function vaultWorld(over: { prefix?: string; wrap?: (real: Fetch) => Fetch } = {}) {
  const v = fakeVault({
    address: ADDRESS,
    roleId: vaultConnection.roleId,
    secretId: SECRET_ID,
    prefix: over.prefix ?? "app/prod",
    leak: LEAK,
  });
  v.seed("app/prod/app/db", {
    password: VALUE,
    user: "orch",
    count: 3,
    empty: "",
    nested: { a: 1 },
  });
  const fetch = over.wrap ? over.wrap(v.fetch) : v.fetch;
  const reader = (secretId = SECRET_ID, timeoutMs?: number): ReferenceReader =>
    vaultReferenceReader(vaultConnection, secretId, { fetch, timeoutMs });
  return { v, reader };
}

describe("the Vault reader", () => {
  test("reads a field of a secret under the prefix", async () => {
    const { v, reader } = vaultWorld();
    const r = reader();
    expect(await r.read(vault("app/db", "password"))).toBe(VALUE);
    expect(await r.read(vault("app/db", "user"))).toBe("orch");
    await r.close();
    expect(v.calls.filter((c) => c.method === "GET").map((c) => c.path)).toEqual([
      "kv/data/app/prod/app/db",
      "kv/data/app/prod/app/db",
    ]);
  });

  test("logs in once for all the reads and lets the token go on close", async () => {
    const { v, reader } = vaultWorld();
    const r = reader();
    await Promise.all([
      r.read(vault("app/db", "password")),
      r.read(vault("app/db", "user")),
      r.read(vault("app/db", "password")),
    ]);
    expect(v.logins).toBe(1);
    expect(v.live.size).toBe(1);
    await r.close();
    expect(v.live.size).toBe(0);
    expect(v.calls.at(-1)?.path).toBe("auth/token/revoke-self");
  });

  test("a reader that read nothing never logged in", async () => {
    const { v, reader } = vaultWorld();
    await reader().close();
    expect(v.calls).toEqual([]);
  });

  test("a path that is not there is not_found", async () => {
    const { reader } = vaultWorld();
    const r = reader();
    expect((await reasonOf(r.read(vault("app/nope", "password")))).reason).toBe("not_found");
    await r.close();
  });

  test("a field that is not there is not_found, and so is one that is empty", async () => {
    const { reader } = vaultWorld();
    const r = reader();
    expect((await reasonOf(r.read(vault("app/db", "absent")))).reason).toBe("not_found");
    expect((await reasonOf(r.read(vault("app/db", "empty")))).reason).toBe("not_found");
    await r.close();
  });

  test("a field named like an Object.prototype member is not found", async () => {
    const { reader } = vaultWorld();
    const r = reader();
    for (const f of ["__proto__", "constructor", "toString"]) {
      expect((await reasonOf(r.read(vault("app/db", f)))).reason).toBe("not_found");
    }
    await r.close();
  });

  test("a field that is not text is not_text", async () => {
    const { reader } = vaultWorld();
    const r = reader();
    expect((await reasonOf(r.read(vault("app/db", "count")))).reason).toBe("not_text");
    expect((await reasonOf(r.read(vault("app/db", "nested")))).reason).toBe("not_text");
    await r.close();
  });

  test("a deleted secret is not_found", async () => {
    const { v, reader } = vaultWorld();
    v.remove("app/prod/app/db");
    const r = reader();
    expect((await reasonOf(r.read(vault("app/db", "password")))).reason).toBe("not_found");
    await r.close();
  });

  test("a policy that does not cover the path is denied", async () => {
    // the connection says app/prod, the AppRole's policy covers another prefix
    const { reader } = vaultWorld({ prefix: "other" });
    const r = reader();
    expect((await reasonOf(r.read(vault("app/db", "password")))).reason).toBe("denied");
    await r.close();
  });

  test("a wrong secret ID is a credential failure, for every read", async () => {
    const { v, reader } = vaultWorld();
    const r = reader("wrong-secret-id-CANARY");
    const first = await reasonOf(r.read(vault("app/db", "password")));
    const second = await reasonOf(r.read(vault("app/db", "user")));
    expect([first.reason, second.reason]).toEqual(["credential", "credential"]);
    expect(first.message).not.toContain("wrong-secret-id-CANARY");
    expect(v.logins).toBe(0);
    await r.close();
    expect(v.calls.some((c) => c.path === "auth/token/revoke-self")).toBe(false);
  });

  test("a Vault that does not answer is unreachable", async () => {
    const { reader } = vaultWorld({
      wrap: () => async () => {
        throw new Error(`connect ECONNREFUSED ${LEAK}`);
      },
    });
    const r = reader();
    const failure = await reasonOf(r.read(vault("app/db", "password")));
    expect(failure.reason).toBe("unreachable");
    expect(failure.message).not.toContain(LEAK);
    await r.close();
  });

  test("a read that fails with a server error is unreachable, a bad answer unexpected", async () => {
    const answer =
      (status: number, body: string): ((real: Fetch) => Fetch) =>
      (real) =>
      async (url, init) =>
        String(init.method) === "GET" && url.includes("/data/")
          ? new Response(body, { status })
          : real(url, init);
    const server = vaultWorld({ wrap: answer(503, `{"errors":["${LEAK}"]}`) });
    const a = server.reader();
    expect((await reasonOf(a.read(vault("app/db", "password")))).reason).toBe("unreachable");
    await a.close();
    const odd = vaultWorld({ wrap: answer(200, "not json") });
    const b = odd.reader();
    expect((await reasonOf(b.read(vault("app/db", "password")))).reason).toBe("unexpected");
    await b.close();
  });

  test("a value over the cap is too_large", async () => {
    const { v, reader } = vaultWorld();
    v.seed("app/prod/big", {
      f: "x".repeat(MAX_REFERENCE_VALUE + 1),
      ok: "x".repeat(MAX_REFERENCE_VALUE),
    });
    const r = reader();
    expect((await reasonOf(r.read(vault("big", "f")))).reason).toBe("too_large");
    expect((await r.read(vault("big", "ok"))).length).toBe(MAX_REFERENCE_VALUE);
    await r.close();
  });

  test("an AWS reference given to a Vault reader is refused", async () => {
    const { v, reader } = vaultWorld();
    const r = reader();
    expect((await reasonOf(r.read(aws("x")))).reason).toBe("wrong_connection");
    expect(v.calls).toEqual([]);
    await r.close();
  });

  test("no error carries the secret ID, a token or what the server said", async () => {
    const { reader } = vaultWorld({ prefix: "other" });
    const r = reader();
    const failure = await reasonOf(r.read(vault("app/db", "password")));
    for (const secret of [SECRET_ID, LEAK, "hvs.fake-client-token"]) {
      expect(failure.message).not.toContain(secret);
      expect(JSON.stringify(failure)).not.toContain(secret);
    }
    await r.close();
  });
});

/** An account with Secrets Manager and the role. */
function awsWorld(over: { wrap?: (real: Fetch) => Fetch; externalId?: string } = {}) {
  const account = fakeAws({
    base: BASE,
    roleArn: ROLE,
    externalId: EXTERNAL_ID,
    region: REGION,
    leak: LEAK,
  });
  account.seedSecret("prod/db", JSON.stringify({ password: VALUE, port: 5432, empty: "" }));
  account.seedSecret("/prod/slash", VALUE);
  account.seedSecret("prod/plain", "not json");
  account.seedSecret("prod/list", JSON.stringify(["a", "b"]));
  const fetch = over.wrap ? over.wrap(account.fetch) : account.fetch;
  const reader = (): ReferenceReader => {
    const d = { fetch };
    return awsReferenceReader(
      { region: REGION },
      assumedSession(d, BASE, {
        roleArn: ROLE,
        region: REGION,
        externalId: over.externalId ?? EXTERNAL_ID,
      }),
      d,
    );
  };
  return { account, reader };
}

describe("the Secrets Manager reader", () => {
  test("reads a whole secret, one with a leading slash, and a field of a JSON one", async () => {
    const { account, reader } = awsWorld();
    const r = reader();
    expect(await r.read(aws("prod/plain"))).toBe("not json");
    expect(await r.read(aws("/prod/slash"))).toBe(VALUE);
    expect(await r.read(aws("prod/db", "password"))).toBe(VALUE);
    await r.close();
    const asked = account.calls
      .filter((c) => c.service === "secretsmanager")
      .map((c) => (c.body as { SecretId: string }).SecretId);
    expect(asked).toEqual(["prod/plain", "/prod/slash", "prod/db"]);
  });

  test("a secret that is not there is not_found", async () => {
    const { reader } = awsWorld();
    expect((await reasonOf(reader().read(aws("prod/nope")))).reason).toBe("not_found");
  });

  test("a field that is not there, or is empty, is not_found", async () => {
    const { reader } = awsWorld();
    const r = reader();
    expect((await reasonOf(r.read(aws("prod/db", "absent")))).reason).toBe("not_found");
    expect((await reasonOf(r.read(aws("prod/db", "empty")))).reason).toBe("not_found");
    expect((await reasonOf(r.read(aws("prod/db", "__proto__")))).reason).toBe("not_found");
  });

  test("a field of something that is not a JSON object, or that is not text, is not_text", async () => {
    const { reader } = awsWorld();
    const r = reader();
    expect((await reasonOf(r.read(aws("prod/plain", "x")))).reason).toBe("not_text");
    expect((await reasonOf(r.read(aws("prod/db", "port")))).reason).toBe("not_text");
    // an array has members "0" and "1", and is still not an object of fields
    expect((await reasonOf(r.read(aws("prod/list", "0")))).reason).toBe("not_text");
  });

  test("a binary secret is not_text", async () => {
    const { reader } = awsWorld({
      wrap: (real) => async (url, init) => {
        const res = await real(url, init);
        if (new Headers(init.headers).get("x-amz-target") !== "secretsmanager.GetSecretValue") {
          return res;
        }
        const { SecretString: _s, ...rest } = (await res.json()) as Record<string, unknown>;
        return Response.json({ ...rest, SecretBinary: "AAEC" });
      },
    });
    expect((await reasonOf(reader().read(aws("prod/plain")))).reason).toBe("not_text");
  });

  test("a role that may not read is denied", async () => {
    const { account, reader } = awsWorld();
    account.denied.add("GetSecretValue");
    expect((await reasonOf(reader().read(aws("prod/plain")))).reason).toBe("denied");
  });

  test("a wrong external ID is a credential failure", async () => {
    const { reader } = awsWorld({ externalId: "wrong-external-id-CANARY" });
    const failure = await reasonOf(reader().read(aws("prod/plain")));
    expect(failure.reason).toBe("credential");
    expect(failure.message).not.toContain("wrong-external-id-CANARY");
  });

  test("an AWS that does not answer is unreachable", async () => {
    const { reader } = awsWorld({
      wrap: () => async () => {
        throw new Error(`connect ECONNREFUSED ${LEAK}`);
      },
    });
    const failure = await reasonOf(reader().read(aws("prod/plain")));
    expect(failure.reason).toBe("unreachable");
    expect(failure.message).not.toContain(LEAK);
  });

  test("a value over the cap is too_large", async () => {
    const { account, reader } = awsWorld();
    account.seedSecret("prod/big", "x".repeat(MAX_REFERENCE_VALUE + 1));
    expect((await reasonOf(reader().read(aws("prod/big")))).reason).toBe("too_large");
  });

  test("a Vault reference given to an AWS reader is refused", async () => {
    const { account, reader } = awsWorld();
    expect((await reasonOf(reader().read(vault("app/db", "password")))).reason).toBe(
      "wrong_connection",
    );
    expect(account.calls).toEqual([]);
  });

  test("no error carries a credential, the secret name's value or what AWS said", async () => {
    const { account, reader } = awsWorld();
    account.denied.add("GetSecretValue");
    const failure = await reasonOf(reader().read(aws("prod/db", "password")));
    for (const secret of [EXTERNAL_ID, BASE.secretAccessKey, LEAK, VALUE]) {
      expect(JSON.stringify(failure)).not.toContain(secret);
      expect(failure.message).not.toContain(secret);
    }
  });
});
