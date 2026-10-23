// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${KEY}` is the reference syntax under test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, DomainError, resolveVariables } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import { createConnection, createOrganization } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { type Fetch, MAX_REFERENCE_VALUE, REFERENCE_WHY, type ReferenceReason } from "@orch/sync";
import { fakeAws, fakeVault } from "@orch/sync/testing";
import { MAX_REFERENCES, type ReferenceDeps, resolveReferences, substitute } from "./references";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

const REGION = "eu-west-1";
const ROLE = "arn:aws:iam::111122223333:role/orch-sync";
const EXTERNAL_ID = "ext-id-CANARY-0123456789";
const BASE = {
  accessKeyId: "AKIAPLATFORM000000",
  secretAccessKey: "platform-secret-key-CANARY-01",
};
const VAULT_ADDRESS = "https://vault.example.test:8200";
const VAULT_SECRET_ID = "vault-secret-id-CANARY-0123456789";
const PREFIX = "app";

const aws = fakeAws({ base: BASE, roleArn: ROLE, externalId: EXTERNAL_ID, region: REGION });
const vault = fakeVault({
  address: VAULT_ADDRESS,
  roleId: "role-id-1234",
  secretId: VAULT_SECRET_ID,
  kvMount: "kv",
  prefix: PREFIX,
});
const reach: Fetch = (url, init) =>
  url.startsWith(VAULT_ADDRESS) ? vault.fetch(url, init) : aws.fetch(url, init);
const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });

let t: TestDb;
let o1: string;
let o2: string;
let deps: ReferenceDeps;

const store = (references?: boolean, prefix = PREFIX) => ({
  address: VAULT_ADDRESS,
  roleId: "role-id-1234",
  kvMount: "kv",
  prefix,
  ...(references === undefined ? {} : { references }),
});
const role = (references?: boolean) => ({
  roleArn: ROLE,
  region: REGION,
  ...(references === undefined ? {} : { references }),
});

beforeAll(async () => {
  t = await createTestDb();
  o1 = (await createOrganization(t.db, { slug: "refs-1", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "refs-2", name: "Two" })).id;
  const connect = (
    org: string,
    type: string,
    name: string,
    config: Record<string, unknown>,
    token: string,
  ) => createConnection(t.db, keys, { organizationId: org, type, name, config, token });
  await connect(o1, "vault_approle", "vault", store(true), VAULT_SECRET_ID);
  await connect(o1, "vault_approle", "vault-off", store(), VAULT_SECRET_ID);
  await connect(o1, "vault_approle", "vault-false", store(false), VAULT_SECRET_ID);
  await connect(o1, "vault_approle", "vault-other-prefix", store(true, "other"), VAULT_SECRET_ID);
  await connect(o1, "vault_approle", "vault-wrong", store(true), "not-the-vault-secret-id-0123");
  await connect(o1, "aws_assume_role", "aws", role(true), EXTERNAL_ID);
  await connect(o1, "aws_assume_role", "aws-off", role(), EXTERNAL_ID);
  await connect(o1, "aws_assume_role", "aws-wrong", role(true), "not-the-external-id");
  await connect(o1, "gitlab", "gl", { baseUrl: "https://gitlab.example.test" }, "x");
  await connect(o2, "vault_approle", "theirs", store(true), VAULT_SECRET_ID);
  deps = { db: t.db, keys, logger, cloud: { fetch: reach, aws: () => BASE } };
});
afterAll(() => t.drop());

type Entry = {
  key: string;
  level: "organization" | "project" | "environment";
  value: string;
  folder?: string;
};
const entry = (key: string, value: string, level: Entry["level"] = "project"): Entry => ({
  key,
  level,
  value,
});
const resolve = (...chains: Entry[][]) => resolveReferences(deps, o1, "req-1", chains);
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e;
    throw e;
  }
  throw new Error("expected a DomainError");
};
const logins = () => vault.logins;
const reads = () => vault.calls.filter((c) => c.path.startsWith("kv/data/")).length;
const secretReads = () => aws.calls.filter((c) => c.action === "GetSecretValue").length;

describe("resolveReferences", () => {
  test("reads a Vault field and an AWS secret, once for each different reference", async () => {
    vault.seed("app/r1/db", { password: "vault-pw-1", other: "unused" });
    aws.seedSecret("r1/db", JSON.stringify({ password: "aws-pw-1" }));
    aws.seedSecret("r1/plain", "just text");
    const found = await resolve([
      entry("A", "vault://vault/r1/db#password"),
      entry("B", "aws-sm://aws/r1/db#password"),
      entry("C", "aws-sm://aws/r1/plain"),
      entry("LITERAL", "not a reference"),
    ]);
    expect(Object.fromEntries(found)).toEqual({
      "vault://vault/r1/db#password": "vault-pw-1",
      "aws-sm://aws/r1/db#password": "aws-pw-1",
      "aws-sm://aws/r1/plain": "just text",
    });
  });

  test("a chain with no reference opens nothing", async () => {
    const before = [logins(), reads(), secretReads(), aws.calls.length];
    expect((await resolve([entry("A", "plain"), entry("B", "see ${A}")])).size).toBe(0);
    expect([logins(), reads(), secretReads(), aws.calls.length]).toEqual(before);
  });

  test("only the entry that wins its key is read: a shadowed pointer is never followed", async () => {
    vault.seed("app/r2/db", { password: "pw" });
    const before = [logins(), reads()];
    const found = await resolve([
      entry("DB", "vault://vault/r2/db#password", "organization"),
      entry("DB", "a literal that wins", "project"),
    ]);
    expect(found.size).toBe(0);
    expect([logins(), reads()]).toEqual(before);

    // and the other way round: the more specific pointer is the one read
    vault.seed("app/r2/env", { password: "env-pw" });
    const won = await resolve([
      entry("DB", "a literal that loses", "project"),
      entry("DB", "vault://vault/r2/env#password", "environment"),
    ]);
    expect([...won.values()]).toEqual(["env-pw"]);
  });

  test("the same pointer in several variables and several chains is read once, on one login", async () => {
    vault.seed("app/r3/a", { f: "one" });
    vault.seed("app/r3/b", { f: "two" });
    const [loggedIn, read] = [logins(), reads()];
    const found = await resolve(
      [entry("A", "vault://vault/r3/a#f"), entry("B", "vault://vault/r3/a#f")],
      [entry("C", "vault://vault/r3/a#f", "environment"), entry("D", "vault://vault/r3/b#f")],
    );
    expect(found.size).toBe(2);
    // two different pointers: two reads; one connection: one login
    expect([logins() - loggedIn, reads() - read]).toEqual([1, 2]);
  });

  test("every token it opened is revoked, on success and on failure", async () => {
    vault.seed("app/r4/ok", { f: "fine" });
    await resolve([entry("A", "vault://vault/r4/ok#f")]);
    expect(vault.live.size).toBe(0);
    const bad = await failure(
      resolve([entry("A", "vault://vault/r4/ok#f"), entry("B", "vault://vault/r4/missing#f")]),
    );
    expect(bad.code).toBe("reference_failed");
    expect(vault.live.size).toBe(0);
  });

  test("more different references than the cap fail before any store is asked", async () => {
    const before = [logins(), reads(), aws.calls.length];
    const many = Array.from({ length: MAX_REFERENCES + 1 }, (_, i) =>
      entry(`K${i}`, `vault://vault/r5/s${i}#f`),
    );
    const e = await failure(resolve(many));
    expect([e.status, e.code]).toEqual([422, "reference_invalid"]);
    expect(e.message).toContain(String(MAX_REFERENCES + 1));
    expect([logins(), reads(), aws.calls.length]).toEqual(before);
    // the same pointer many times is one reference, not many
    vault.seed("app/r5/one", { f: "v" });
    const same = Array.from({ length: MAX_REFERENCES + 5 }, (_, i) =>
      entry(`K${i}`, "vault://vault/r5/one#f"),
    );
    expect((await resolve(same)).size).toBe(1);
  });

  test("exactly the cap of different references is read, on one login", async () => {
    vault.seed(
      "app/r5/many",
      Object.fromEntries(Array.from({ length: MAX_REFERENCES }, (_, i) => [`f${i}`, `v${i}`])),
    );
    const loggedIn = logins();
    const found = await resolve(
      Array.from({ length: MAX_REFERENCES }, (_, i) =>
        entry(`K${i}`, `vault://vault/r5/many#f${i}`),
      ),
    );
    expect(found.size).toBe(MAX_REFERENCES);
    expect(found.get("vault://vault/r5/many#f49")).toBe("v49");
    expect(logins() - loggedIn).toBe(1);
  });

  test("a failure that is not a reference's own is passed on, never read as 'no references'", async () => {
    // no platform identity: opening the AWS connection fails with a DomainError of its own
    const noIdentity = { ...deps, cloud: { fetch: reach, aws: () => undefined } };
    const e = await failure(
      resolveReferences(noIdentity, o1, "req-1", [[entry("A", "aws-sm://aws/r6/a")]]),
    );
    expect([e.status, e.code]).toEqual([503, "aws_identity_unavailable"]);
    // with the Vault ones still readable beside it: the whole call fails, not just the pointer
    vault.seed("app/r6/ok", { f: "x" });
    const mixed = await failure(
      resolveReferences(noIdentity, o1, "req-1", [
        [entry("A", "aws-sm://aws/r6/a"), entry("B", "vault://vault/r6/ok#f")],
      ]),
    );
    expect(mixed.code).toBe("aws_identity_unavailable");
    expect(vault.live.size).toBe(0);
  });

  test("a connection of another organization, a missing one, or a wrong type is the reference's fault", async () => {
    const words: Record<string, ReferenceReason> = {
      "vault://theirs/r6/a#f": "unknown_connection",
      "vault://nope/r6/a#f": "unknown_connection",
      "vault://gl/r6/a#f": "wrong_connection",
      "aws-sm://gl/r6/a": "wrong_connection",
      // a reference of one store through a connection to the other
      "vault://aws/r6/a#f": "wrong_connection",
      "aws-sm://vault/r6/a": "wrong_connection",
      "vault://vault-off/r6/a#f": "not_enabled",
      "vault://vault-false/r6/a#f": "not_enabled",
      "aws-sm://aws-off/r6/a": "not_enabled",
      "vault:///a#f": "malformed",
      "vault://vault/a": "malformed",
      "aws-sm://aws": "malformed",
    };
    for (const [pointer, reason] of Object.entries(words)) {
      const before = [logins(), reads(), aws.calls.length];
      const e = await failure(resolve([entry("KEY", pointer)]));
      expect([pointer, e.status, e.code]).toEqual([pointer, 422, "reference_invalid"]);
      expect(e.message).toContain(`KEY ${REFERENCE_WHY[reason]}`);
      // a connection that does not allow references is never logged in to
      expect([logins(), reads(), aws.calls.length]).toEqual(before);
    }
  });

  test("the other organization's connection answers for its own organization only", async () => {
    vault.seed("app/r7/a", { f: "theirs-value" });
    const found = await resolveReferences(deps, o2, "req-2", [
      [entry("A", "vault://theirs/r7/a#f")],
    ]);
    expect([...found.values()]).toEqual(["theirs-value"]);
    const e = await failure(
      resolveReferences(deps, o2, "req-2", [[entry("A", "vault://vault/r7/a#f")]]),
    );
    expect(e.code).toBe("reference_invalid");
  });

  test("a store that will not give it is a bad gateway, in fixed words", async () => {
    vault.seed("app/r8/field", { present: "x" });
    vault.seed("app/r8/number", { n: 5 });
    vault.seed("app/r8/empty", { e: "" });
    vault.seed("app/r8/big", { b: "x".repeat(MAX_REFERENCE_VALUE + 1) });
    aws.seedSecret("r8/json", JSON.stringify({ present: "x" }));
    aws.seedSecret("r8/notjson", "not json at all");
    const cases: [string, ReferenceReason][] = [
      ["vault://vault/r8/missing#f", "not_found"],
      ["vault://vault/r8/field#absent", "not_found"],
      ["vault://vault/r8/empty#e", "not_found"],
      ["vault://vault/r8/number#n", "not_text"],
      ["vault://vault/r8/big#b", "too_large"],
      ["vault://vault-other-prefix/r8/field#present", "denied"],
      ["vault://vault-wrong/r8/field#present", "credential"],
      ["aws-sm://aws/r8/missing", "not_found"],
      ["aws-sm://aws/r8/json#absent", "not_found"],
      ["aws-sm://aws/r8/notjson#present", "not_text"],
      ["aws-sm://aws-wrong/r8/json#present", "credential"],
    ];
    for (const [pointer, reason] of cases) {
      const e = await failure(resolve([entry("KEY", pointer)]));
      expect([pointer, e.status, e.code]).toEqual([pointer, 502, "reference_failed"]);
      expect(e.message).toContain(`KEY ${REFERENCE_WHY[reason]}`);
      // what the message may say: the key and fixed words, nothing of the store
      for (const leaked of [VAULT_SECRET_ID, EXTERNAL_ID, "r8/", "present", "app/"]) {
        expect([pointer, e.message.includes(leaked)]).toEqual([pointer, false]);
      }
    }
    expect(vault.live.size).toBe(0);
  });

  test("a refused action at the store is the credential's, a malformed one the reference's, and the worse one decides", async () => {
    vault.seed("app/r9/a", { f: "x" });
    const mixed = await failure(
      resolve([entry("GONE", "vault://vault/r9/missing#f"), entry("BAD", "vault://vault/a")]),
    );
    expect([mixed.status, mixed.code]).toEqual([422, "reference_invalid"]);
    // both are named, in key order
    expect(mixed.message).toMatch(/BAD .*; GONE /);
    aws.denied.add("GetSecretValue");
    try {
      const e = await failure(resolve([entry("A", "aws-sm://aws/r9/a")]));
      expect([e.status, e.code]).toEqual([502, "reference_failed"]);
      expect(e.message).toContain(`A ${REFERENCE_WHY.denied}`);
    } finally {
      aws.denied.delete("GetSecretValue");
    }
  });

  test("one bad reference fails the whole call, and nothing it read is returned or logged", async () => {
    vault.seed("app/r10/ok", { f: "SEKRIT-r10-value" });
    const e = await failure(
      resolve([entry("OK", "vault://vault/r10/ok#f"), entry("BAD", "vault://vault/r10/gone#f")]),
    );
    expect(e.message).toContain("1 variable(s)");
    expect(e.message).toContain("BAD ");
    expect(e.message).not.toContain("OK ");
    const logged = lines.join("\n");
    for (const leaked of ["SEKRIT-r10-value", VAULT_SECRET_ID, EXTERNAL_ID, "r10/"]) {
      expect(logged).not.toContain(leaked);
      expect(e.message).not.toContain(leaked);
    }
    expect(logged).toContain("references could not be read");
  });

  test("the same key in two folders is two variables: each wins at its own address", async () => {
    vault.seed("app/r12/root", { f: "root-pw" });
    vault.seed("app/r12/pay", { f: "pay-pw" });
    vault.seed("app/r12/shadowed", { f: "never read" });
    const found = await resolve([
      entry("DB", "vault://vault/r12/root#f", "organization"),
      { ...entry("DB", "vault://vault/r12/pay#f"), folder: "/pay" },
      // in one folder the most specific level still wins
      { ...entry("OTHER", "vault://vault/r12/shadowed#f"), folder: "/pay" },
      { ...entry("OTHER", "a literal", "environment"), folder: "/pay" },
    ]);
    expect(Object.fromEntries(found)).toEqual({
      "vault://vault/r12/root#f": "root-pw",
      "vault://vault/r12/pay#f": "pay-pw",
    });
  });

  test("a failure names a variable in a folder by its address, and one at the root by its key", async () => {
    const e = await failure(
      resolve([
        entry("AT_ROOT", "vault://vault/r13/gone#f"),
        { ...entry("IN_FOLDER", "vault://vault/r13/gone#f"), folder: "/pay" },
      ]),
    );
    expect(e.message).toContain("2 variable(s)");
    expect(e.message).toContain("/pay/IN_FOLDER ");
    expect(e.message).toMatch(/(^|: |; )AT_ROOT /);
  });

  test("a long list of failures names ten variables and counts the rest", async () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      entry(`K${String(i).padStart(2, "0")}`, `vault://vault/r11/s${i}#f`),
    );
    const e = await failure(resolve(many));
    expect(e.message).toContain("14 variable(s)");
    expect(e.message).toContain("K09 ");
    expect(e.message).not.toContain("K10 ");
    expect(e.message).toContain("and 4 more");
  });
});

describe("substitute", () => {
  const E = (
    over: Partial<Entry> & { kind?: "plain" | "secret" | "file"; extra?: number } = {},
  ) => ({
    key: "K",
    level: "project" as const,
    kind: "plain" as "plain" | "secret" | "file",
    value: "vault://vault/a/b#f",
    extra: 7,
    ...over,
  });
  const resolved = new Map([["vault://vault/a/b#f", "from the store"]]);

  test("a plain pointer becomes a secret holding the resolved text, and the rest of the entry stays", () => {
    expect(substitute([E()], resolved)).toEqual([E({ kind: "secret", value: "from the store" })]);
  });

  test("a secret stays a secret and a file stays a file, whose text is not escaped", () => {
    const text = new Map([["vault://vault/a/b#f", "a ${B} and $${C}"]]);
    const [secret, file] = substitute([E({ kind: "secret" }), E({ kind: "file", key: "F" })], text);
    expect(secret).toMatchObject({ kind: "secret", value: "a $${B} and $$${C}" });
    expect(file).toMatchObject({ kind: "file", value: "a ${B} and $${C}" });
  });

  test("whatever the store held comes out of resolveVariables as it was, not read as references", () => {
    const texts = ["plain", "${NOPE}", "$${NOPE}", "$$${NOPE}", "a${B}c$${D}$", "$", "${"];
    for (const text of texts) {
      const out = substitute(
        [
          {
            id: "v",
            key: "V",
            level: "project" as const,
            kind: "plain" as const,
            value: "vault://vault/a/b#f",
          },
          { id: "b", key: "B", level: "project" as const, kind: "plain" as const, value: "b" },
        ],
        new Map([["vault://vault/a/b#f", text]]),
      );
      const { variables, issues } = resolveVariables(out);
      expect(issues).toEqual([]);
      expect(variables.find((v) => v.key === "V")).toMatchObject({ kind: "secret", value: text });
    }
  });

  test("an entry that loses its key, is not a pointer or was not resolved is returned as it is", () => {
    const chain = [
      E({ level: "organization" }),
      E({ value: "a literal" }),
      E({ key: "OTHER", value: "vault://vault/not/read#f" }),
    ];
    const out = substitute(chain, resolved);
    expect(out).toEqual(chain);
    expect(out[0]).toBe(chain[0]);
  });

  test("the winner is by address: the same key in another folder does not shadow it", () => {
    const out = substitute([E({ level: "organization" }), E({ folder: "/pay" })], resolved);
    expect(out.map((e) => e.value)).toEqual(["from the store", "from the store"]);
    const shadowed = substitute(
      [E({ folder: "/pay" }), E({ folder: "/pay", level: "environment" })],
      resolved,
    );
    expect(shadowed.map((e) => e.value)).toEqual(["vault://vault/a/b#f", "from the store"]);
  });

  test("a pointer at the winning level is replaced in every entry of that level that holds it", () => {
    const out = substitute([E({ key: "A" }), E({ key: "B" })], resolved);
    expect(out.map((e) => e.value)).toEqual(["from the store", "from the store"]);
  });
});
