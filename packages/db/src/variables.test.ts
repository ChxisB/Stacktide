import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BulkOp } from "@orch/core";
import { aad, CryptoError, encrypt, envKeyProvider, generateDek, wrapDek } from "@orch/crypto";
import { eq, sql } from "drizzle-orm";
import { createFolder, FolderNotFoundError } from "./folders";
import { pgCode, pgConstraint } from "./pg-error";
import {
  createEnvironment,
  createOrganization,
  createProject,
  deleteEnvironment,
  deleteOrganization,
  deleteProject,
} from "./repo";
import { variableFolders, variableKeys, variables, variableVersions } from "./schema";
import { createTestDb, type TestDb } from "./testing";
import {
  bulkLevel,
  chainKeys,
  createVariable,
  deleteVariable,
  getVariable,
  listVariableChanges,
  listVariables,
  listVersions,
  moveVariable,
  openChain,
  revealVariable,
  type Scope,
  searchVariables,
  setVariable,
} from "./variables";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const keys = envKeyProvider(`k2:${key(2)},k1:${key(1)}`);
const actor = { kind: "user", id: "u1" };
const CANARY = "s3cr3t-CANARY-value-0123456789";

let n = 0;
const world = async () => {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${n}` });
  const env = await createEnvironment(t.db, {
    organizationId: org.id,
    projectId: project.id,
    name: "Prod",
    slug: "prod",
  });
  const other = await createEnvironment(t.db, {
    organizationId: org.id,
    projectId: project.id,
    name: "Dev",
    slug: "dev",
  });
  const at = {
    org: { organizationId: org.id },
    project: { organizationId: org.id, projectId: project.id },
    env: { organizationId: org.id, projectId: project.id, environmentId: env.id },
  };
  return { org, project, env, other, at };
};
const make = (
  scope: Scope,
  over: Partial<{ key: string; kind: "plain" | "secret" | "file"; value: string }> = {},
) =>
  createVariable(t.db, keys, {
    ...scope,
    key: over.key ?? `K${++n}`,
    kind: over.kind ?? "secret",
    value: over.value ?? CANARY,
    actor,
  });
const code = async (p: Promise<unknown>) => pgCode(await p.catch((e) => e));
const rawAll = async (table: string) => await t.db.execute(sql.raw(`SELECT * FROM ${table}`));
const bytes = (v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : "");

describe("values at rest", () => {
  test("every kind is sealed: a raw read of the three tables holds no plaintext", async () => {
    const w = await world();
    for (const kind of ["plain", "secret", "file"] as const) {
      await make(w.at.project, { kind, value: `${kind}-${CANARY}` });
    }
    await make(w.at.org, { kind: "secret" });
    for (const table of ["variables", "variable_versions", "variable_keys"]) {
      for (const row of await rawAll(table)) {
        for (const value of Object.values(row as Record<string, unknown>)) {
          if (value === null) continue;
          expect(JSON.stringify(value) + bytes(value)).not.toContain(CANARY);
        }
      }
    }
    const [v] = await t.db.execute(sql`SELECT value_enc, actor_id FROM variable_versions LIMIT 1`);
    expect(Buffer.from((v as { value_enc: Uint8Array }).value_enc).length).toBeGreaterThan(
      CANARY.length,
    );
  });

  test("a plain value comes back with the variable; a secret or file never does", async () => {
    const w = await world();
    const plain = await make(w.at.project, { kind: "plain", value: "https://example.com" });
    const secret = await make(w.at.project, { kind: "secret" });
    const file = await make(w.at.project, { kind: "file", value: `-----BEGIN-----${CANARY}` });
    expect(plain.value).toBe("https://example.com");
    expect(secret.value).toBeNull();
    expect(file.value).toBeNull();
    const listed = await listVariables(t.db, keys, w.at.project, { limit: 10 });
    const got = await getVariable(t.db, keys, w.at.project, secret.id);
    expect(listed.map((v) => v.value ?? "-").sort()).toEqual(["-", "-", "https://example.com"]);
    expect(got?.value).toBeNull();
    expect(JSON.stringify([secret, file, listed, got])).not.toContain(CANARY);
    // No view holds a ciphertext or key column.
    expect(Object.keys(plain).sort()).toEqual(
      [
        "createdAt",
        "currentVersion",
        "description",
        "environmentId",
        "folder",
        "id",
        "key",
        "kind",
        "organizationId",
        "projectId",
        "tags",
        "updatedAt",
        "value",
      ].sort(),
    );
  });

  test("revealVariable is the way to a secret, for the current or an earlier version", async () => {
    const w = await world();
    const v = await make(w.at.project, { value: "first" });
    await setVariable(t.db, keys, w.at.project, v.id, { value: "second", actor });
    expect(await revealVariable(t.db, keys, w.at.project, v.id)).toMatchObject({
      version: 2,
      value: "second",
      variable: { id: v.id, key: v.key, kind: "secret" },
    });
    expect((await revealVariable(t.db, keys, w.at.project, v.id, 1))?.value).toBe("first");
    expect(await revealVariable(t.db, keys, w.at.project, v.id, 3)).toBeUndefined();
  });

  test("one data key per owner, wrapped by the current master key, made once even in a race", async () => {
    const w = await world();
    const vars = await Promise.all(
      Array.from({ length: 6 }, (_, i) => make(w.at.project, { key: `RACE_${i}`, value: `v${i}` })),
    );
    await make(w.at.org, { value: "org" });
    const rows = (await rawAll("variable_keys")) as {
      organization_id: string;
      project_id: string | null;
      dek_key_id: string;
    }[];
    expect(rows.filter((r) => r.project_id === w.project.id)).toHaveLength(1);
    expect(
      rows.filter((r) => r.organization_id === w.org.id && r.project_id === null),
    ).toHaveLength(1);
    expect(rows.every((r) => r.dek_key_id === "k2")).toBe(true);
    for (const [i, v] of vars.entries()) {
      expect((await revealVariable(t.db, keys, w.at.project, v.id))?.value).toBe(`v${i}`);
    }
  });

  test("a ciphertext or wrapped key moved to another row does not open", async () => {
    const w = await world();
    const [a, b] = [
      await make(w.at.project, { value: "A" }),
      await make(w.at.project, { value: "B" }),
    ];
    await setVariable(t.db, keys, w.at.project, a.id, { value: "A2", actor });
    // Version 2 of b is a's version 2: same number, sealed for another variable.
    await t.db.execute(sql`
      INSERT INTO variable_versions (variable_id, version, value_enc, actor_kind, actor_id)
      SELECT ${b.id}, 2, value_enc, 'user', 'u1' FROM variable_versions
      WHERE variable_id = ${a.id} AND version = 2`);
    await t.db.execute(sql`UPDATE variables SET current_version = 2 WHERE id = ${b.id}`);
    await expect(revealVariable(t.db, keys, w.at.project, b.id)).rejects.toBeInstanceOf(
      CryptoError,
    );
    expect((await revealVariable(t.db, keys, w.at.project, b.id, 1))?.value).toBe("B");

    // ...and version 1's ciphertext as version 2 of the same variable: sealed for another version.
    const c1 = await make(w.at.project, { value: "C1" });
    await t.db.execute(sql`
      INSERT INTO variable_versions (variable_id, version, value_enc, actor_kind, actor_id)
      SELECT variable_id, 2, value_enc, 'user', 'u1' FROM variable_versions WHERE variable_id = ${c1.id}`);
    await t.db.execute(sql`UPDATE variables SET current_version = 2 WHERE id = ${c1.id}`);
    await expect(revealVariable(t.db, keys, w.at.project, c1.id)).rejects.toBeInstanceOf(
      CryptoError,
    );

    // Another project's wrapped key in this project's slot.
    const w2 = await world();
    const c = await make(w2.at.project, { value: "C" });
    await t.db.execute(sql`
      UPDATE variable_keys SET dek_wrapped = (SELECT dek_wrapped FROM variable_keys WHERE project_id = ${w2.project.id})
      WHERE project_id = ${w.project.id}`);
    await expect(revealVariable(t.db, keys, w.at.project, a.id)).rejects.toBeInstanceOf(
      CryptoError,
    );
    expect((await revealVariable(t.db, keys, w2.at.project, c.id))?.value).toBe("C");
  });

  // Hand-built rows pin what ciphertexts and keys are bound to (the owner, as well as the row).
  // `sealedFor` and `wrappedFor` are the projects the value's AAD and the data key's wrap name.
  const plant = async (sealedFor: "here" | "elsewhere", wrappedFor: "here" | "elsewhere") => {
    const w = await world();
    const elsewhere = await createProject(t.db, { organizationId: w.org.id, name: "elsewhere" });
    const [here, away] = [w.project.id, elsewhere.id];
    const [aadProject, wrapProject] = [
      sealedFor === "here" ? here : away,
      wrappedFor === "here" ? here : away,
    ];
    const dek = generateDek();
    const wrap = await wrapDek(keys, dek, `variables:project:${wrapProject}`);
    await t.db.insert(variableKeys).values({
      organizationId: w.org.id,
      projectId: here,
      dekKeyId: wrap.keyId,
      dekWrapped: wrap.wrapped,
    });
    const id = Bun.randomUUIDv7();
    await t.db
      .insert(variables)
      .values({ id, organizationId: w.org.id, projectId: here, key: "PLANTED", kind: "secret" });
    await t.db.insert(variableVersions).values({
      variableId: id,
      version: 1,
      valueEnc: encrypt(dek, "planted", aad("variable", w.org.id, aadProject, id, "1")),
      actorKind: "user",
      actorId: "u1",
    });
    return revealVariable(t.db, keys, w.at.project, id);
  };

  test("a value sealed for another project does not open in this one", async () => {
    expect((await plant("here", "here"))?.value).toBe("planted"); // the control: built right, opens
    await expect(plant("elsewhere", "here")).rejects.toBeInstanceOf(CryptoError);
  });

  test("a data key wrapped for another project does not unwrap in this one", async () => {
    await expect(plant("here", "elsewhere")).rejects.toBeInstanceOf(CryptoError);
  });

  test("without the master key a value does not open, and the error says nothing of it", async () => {
    const w = await world();
    const v = await make(w.at.project);
    const other = envKeyProvider(`k9:${key(9)}`);
    const err = await revealVariable(t.db, other, w.at.project, v.id).catch((e) => e);
    expect(err).toBeInstanceOf(CryptoError);
    expect(String(err.message)).not.toContain(CANARY);
  });
});

describe("keys are unique per level, among live variables", () => {
  test("a key can be used once at each level", async () => {
    const w = await world();
    await make(w.at.org, { key: "DUP" });
    await make(w.at.project, { key: "DUP" });
    await make(w.at.env, { key: "DUP" });
    for (const scope of [w.at.org, w.at.project, w.at.env]) {
      const err = await make(scope, { key: "DUP" }).catch((e) => e);
      expect(pgCode(err)).toBe("23505");
    }
    expect(await code(make(w.at.org, { key: "DUP" }))).toBe("23505");
  });

  test("the same key is fine in another environment, project, organization or letter case", async () => {
    const w = await world();
    const w2 = await world();
    await make(w.at.env, { key: "SAME" });
    await make({ ...w.at.env, environmentId: w.other.id }, { key: "SAME" });
    await make(w2.at.env, { key: "SAME" });
    await make(w.at.project, { key: "same" });
    await make(w.at.project, { key: "SAME" });
    await make(w2.at.org, { key: "SAME" });
    expect(await listVariables(t.db, keys, w.at.env, { limit: 10 })).toHaveLength(1);
  });

  test("keys must be environment variable names", async () => {
    const w = await world();
    for (const bad of ["", "1A", "A-B", "A B", "A.B", "é", "A".repeat(256), "A\n"]) {
      const err = await make(w.at.project, { key: bad }).catch((e) => e);
      expect([bad, pgCode(err), pgConstraint(err)]).toEqual([bad, "23514", "variables_key_check"]);
    }
    await make(w.at.project, { key: `_${"a".repeat(254)}` });
    await make(w.at.project, { key: "_" });
  });

  test("a kind outside plain, secret and file, or an environment without a project, is refused", async () => {
    const w = await world();
    const bad = await make(w.at.project, { kind: "hidden" as "plain" }).catch((e) => e);
    expect(pgConstraint(bad)).toBe("variables_kind_check");
    const orphan = await make({
      organizationId: w.org.id,
      environmentId: w.env.id,
    } as Scope).catch((e) => e);
    expect(pgConstraint(orphan)).toBe("variables_scope_check");
  });

  test("a project or environment of another organization or project is refused", async () => {
    const w = await world();
    const w2 = await world();
    const crossProject = { organizationId: w.org.id, projectId: w2.project.id };
    expect(pgConstraint(await make(crossProject).catch((e) => e))).toMatch(/_project_org_fk$/);
    const crossEnv = { ...w.at.project, environmentId: w2.env.id };
    expect(pgConstraint(await make(crossEnv).catch((e) => e))).toBe(
      "variables_environment_project_fk",
    );
    // Nothing was left behind by the refused writes (not even a data key).
    expect(await listVariables(t.db, keys, w.at.project, { limit: 10 })).toHaveLength(0);
    const stray = await t.db.execute(
      sql`SELECT 1 FROM variable_keys WHERE project_id = ${w2.project.id}`,
    );
    expect(stray).toHaveLength(0);
  });
});

describe("levels and scoping", () => {
  test("lists show one level each, keyset paged by id", async () => {
    const w = await world();
    const org = await make(w.at.org, { key: "A" });
    const proj = await Promise.all(["B", "C", "D"].map((k) => make(w.at.project, { key: k })));
    const env = await make(w.at.env, { key: "E" });
    expect((await listVariables(t.db, keys, w.at.org, { limit: 10 })).map((v) => v.id)).toEqual([
      org.id,
    ]);
    expect((await listVariables(t.db, keys, w.at.env, { limit: 10 })).map((v) => v.id)).toEqual([
      env.id,
    ]);
    const first = await listVariables(t.db, keys, w.at.project, { limit: 2 });
    const rest = await listVariables(t.db, keys, w.at.project, { limit: 2, after: first[1]?.id });
    expect([...first, ...rest].map((v) => v.id)).toEqual(proj.map((v) => v.id).sort());
  });

  test("an id is found only under its own organization, project and level", async () => {
    const w = await world();
    const w2 = await world();
    const v = await make(w.at.project, { kind: "plain", value: "x" });
    const org = await make(w.at.org, { kind: "plain", value: "y" });
    const e = await make(w.at.env, { kind: "plain", value: "e" });
    const otherEnv = { ...w.at.env, environmentId: w.other.id };
    const reach = (hidden: { id: string }, scopes: Scope[]) =>
      Promise.all(
        scopes.map(async (scope) => {
          expect(await getVariable(t.db, keys, scope, hidden.id)).toBeUndefined();
          expect(await revealVariable(t.db, keys, scope, hidden.id)).toBeUndefined();
          expect(
            await setVariable(t.db, keys, scope, hidden.id, { value: "z", actor }),
          ).toBeUndefined();
          expect(await deleteVariable(t.db, scope, hidden.id)).toBe(false);
          expect(await listVersions(t.db, scope, hidden.id, { limit: 5 })).toEqual([]);
        }),
      );
    await reach(v, [
      w2.at.project, // another org and project
      { organizationId: w.org.id, projectId: w2.project.id }, // right org, wrong project
      w.at.org, // the org level does not see project-level rows
      w.at.env, // nor does an environment
    ]);
    await reach(org, [w.at.project, w.at.env]);
    // Only the environment itself reaches an environment's variable: not its project, not a sibling.
    await reach(e, [w.at.project, w.at.org, otherEnv, w2.at.env]);
    expect((await getVariable(t.db, keys, w.at.project, v.id))?.value).toBe("x");
    expect((await getVariable(t.db, keys, w.at.org, org.id))?.value).toBe("y");
    expect((await getVariable(t.db, keys, w.at.env, e.id))?.environmentId).toBe(w.env.id);
    // ...and the hidden ones are untouched by all of that.
    expect((await getVariable(t.db, keys, w.at.env, e.id))?.currentVersion).toBe(1);
    expect(await listVersions(t.db, w.at.project, v.id, { limit: 5 })).toHaveLength(1);
  });
});

describe("versions", () => {
  test("a new value is a new version; the old ones stay, newest first", async () => {
    const w = await world();
    const v = await make(w.at.project, { value: "one" });
    expect(v.currentVersion).toBe(1);
    const second = await setVariable(t.db, keys, w.at.project, v.id, {
      value: "two",
      actor: { kind: "token", id: "t9" },
      reason: "rotated",
    });
    await setVariable(t.db, keys, w.at.project, v.id, { value: "three", actor });
    expect(second?.currentVersion).toBe(2);
    const all = await listVersions(t.db, w.at.project, v.id, { limit: 10 });
    expect(all.map((x) => x.version)).toEqual([3, 2, 1]);
    expect(all[1]).toMatchObject({ actorKind: "token", actorId: "t9", reason: "rotated" });
    expect(all[2]).toMatchObject({ actorKind: "user", actorId: "u1", reason: null });
    expect(Object.keys(all[0] ?? {}).sort()).toEqual(
      ["actorId", "actorKind", "createdAt", "reason", "version"].sort(),
    );
    const page = await listVersions(t.db, w.at.project, v.id, { limit: 1, after: 3 });
    expect(page.map((x) => x.version)).toEqual([2]);
    expect((await revealVariable(t.db, keys, w.at.project, v.id))?.value).toBe("three");
  });

  test("a description change makes no new version", async () => {
    const w = await world();
    const v = await make(w.at.project, { kind: "plain", value: "same" });
    const changed = await setVariable(t.db, keys, w.at.project, v.id, {
      description: "what it is",
      actor,
    });
    expect(changed).toMatchObject({ description: "what it is", currentVersion: 1, value: "same" });
    expect(await listVersions(t.db, w.at.project, v.id, { limit: 10 })).toHaveLength(1);
    await setVariable(t.db, keys, w.at.project, v.id, { value: "next", description: "d2", actor });
    expect((await getVariable(t.db, keys, w.at.project, v.id))?.description).toBe("d2");
  });

  test("concurrent writes each get their own version", async () => {
    const w = await world();
    const v = await make(w.at.project, { value: "v1" });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        setVariable(t.db, keys, w.at.project, v.id, { value: `c${i}`, actor }),
      ),
    );
    const versions = await listVersions(t.db, w.at.project, v.id, { limit: 10 });
    expect(versions.map((x) => x.version)).toEqual([6, 5, 4, 3, 2, 1]);
    expect((await getVariable(t.db, keys, w.at.project, v.id))?.currentVersion).toBe(6);
  });

  test("a lost data key is an error, not a reason to make another and orphan the old versions", async () => {
    const w = await world();
    const v = await make(w.at.project, { value: "one" });
    await t.db.execute(sql`DELETE FROM variable_keys WHERE project_id = ${w.project.id}`);
    await expect(
      setVariable(t.db, keys, w.at.project, v.id, { value: "two", actor }),
    ).rejects.toThrow("variable key missing");
    const rows = await t.db.execute(
      sql`SELECT current_version, (SELECT count(*) FROM variable_keys WHERE project_id = ${w.project.id}) AS keys FROM variables WHERE id = ${v.id}`,
    );
    expect(rows[0]).toMatchObject({ current_version: 1, keys: "0" }); // rolled back whole
    // Reading does not make one either.
    await expect(revealVariable(t.db, keys, w.at.project, v.id)).rejects.toThrow(
      "variable key missing",
    );
    const after = await t.db.execute(
      sql`SELECT 1 FROM variable_keys WHERE project_id = ${w.project.id}`,
    );
    expect(after).toHaveLength(0);
  });

  test("a patch with nothing in it changes nothing", async () => {
    const w = await world();
    const v = await make(w.at.project, { kind: "plain", value: "same" });
    const same = await setVariable(t.db, keys, w.at.project, v.id, { actor });
    expect(same).toEqual(v);
    expect(await setVariable(t.db, keys, w.at.org, v.id, { actor })).toBeUndefined();
  });

  test("a version number can be used once per variable", async () => {
    const w = await world();
    const v = await make(w.at.project);
    const again = t.db.execute(sql`
      INSERT INTO variable_versions (variable_id, version, value_enc, actor_kind, actor_id)
      SELECT variable_id, version, value_enc, 'user', 'u1' FROM variable_versions WHERE variable_id = ${v.id}`);
    expect(await code(again)).toBe("23505");
  });

  test("versions are append-only: no update, no delete, no truncate", async () => {
    const w = await world();
    const v = await make(w.at.project);
    const attempts = [
      t.db.execute(sql`UPDATE variable_versions SET reason = 'x' WHERE variable_id = ${v.id}`),
      t.db.execute(sql`DELETE FROM variable_versions WHERE variable_id = ${v.id}`),
      t.db.execute(sql`TRUNCATE variable_versions`),
    ];
    for (const attempt of attempts) expect(await code(attempt)).toBe("55000");
    expect(await listVersions(t.db, w.at.project, v.id, { limit: 10 })).toHaveLength(1);
  });
});

describe("tags", () => {
  const tagged = (scope: Scope, tags: string[]) =>
    createVariable(t.db, keys, {
      ...scope,
      key: `K${++n}`,
      kind: "plain",
      value: "same",
      tags,
      actor,
    });

  test("a variable made without tags has none, and one made with tags keeps them", async () => {
    const w = await world();
    expect((await make(w.at.project)).tags).toEqual([]);
    const v = await tagged(w.at.project, ["api", "eu"]);
    expect(v.tags).toEqual(["api", "eu"]);
    expect((await getVariable(t.db, keys, w.at.project, v.id))?.tags).toEqual(["api", "eu"]);
    const listed = await listVariables(t.db, keys, w.at.project, { limit: 10 });
    expect(listed.find((x) => x.id === v.id)?.tags).toEqual(["api", "eu"]);
  });

  test("a patch replaces the tags and makes no new version; no tags in the patch leaves them", async () => {
    const w = await world();
    const v = await tagged(w.at.project, ["api"]);
    const changed = await setVariable(t.db, keys, w.at.project, v.id, { tags: ["b", "a"], actor });
    expect(changed).toMatchObject({ tags: ["b", "a"], currentVersion: 1, value: "same" });
    expect(await listVersions(t.db, w.at.project, v.id, { limit: 10 })).toHaveLength(1);
    const kept = await setVariable(t.db, keys, w.at.project, v.id, { description: "d", actor });
    expect(kept?.tags).toEqual(["b", "a"]);
    const cleared = await setVariable(t.db, keys, w.at.project, v.id, { tags: [], actor });
    expect(cleared?.tags).toEqual([]);
  });

  test("a patch of tags alone is a change; under another level it finds nothing", async () => {
    const w = await world();
    const v = await tagged(w.at.project, []);
    expect(await setVariable(t.db, keys, w.at.org, v.id, { tags: ["x"], actor })).toBeUndefined();
    expect((await getVariable(t.db, keys, w.at.project, v.id))?.tags).toEqual([]);
  });

  test("the chain an environment resolves from carries them", async () => {
    const w = await world();
    const v = await tagged(w.at.env, ["env-tag"]);
    const entry = (await openChain(t.db, keys, w.at.env)).find((c) => c.id === v.id);
    expect(entry?.tags).toEqual(["env-tag"]);
  });

  test("a ninth tag, a long tag, an upper-case tag and an empty tag are refused", async () => {
    const w = await world();
    const nine = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    for (const bad of [nine, ["x".repeat(25)], ["Api"], [""], ["a b"], ["a,b"]]) {
      const made = await tagged(w.at.project, bad).catch((e) => e);
      expect([bad, pgConstraint(made)]).toEqual([bad, "variables_tags_check"]);
    }
    const v = await tagged(w.at.project, ["ok"]);
    const patched = await setVariable(t.db, keys, w.at.project, v.id, {
      tags: ["BAD"],
      actor,
    }).catch((e) => e);
    expect(pgConstraint(patched)).toBe("variables_tags_check");
    expect((await getVariable(t.db, keys, w.at.project, v.id))?.tags).toEqual(["ok"]);
    await tagged(w.at.project, nine.slice(0, 8));
    await tagged(w.at.project, ["x".repeat(24), "0-9"]);
  });
});

describe("soft delete", () => {
  test("a deleted variable disappears, keeps its history and frees its key", async () => {
    const w = await world();
    const v = await make(w.at.project, { key: "GONE", value: "old" });
    await setVariable(t.db, keys, w.at.project, v.id, { value: "newer", actor });
    expect(await deleteVariable(t.db, w.at.project, v.id)).toBe(true);
    expect(await deleteVariable(t.db, w.at.project, v.id)).toBe(false);

    expect(await getVariable(t.db, keys, w.at.project, v.id)).toBeUndefined();
    expect(await listVariables(t.db, keys, w.at.project, { limit: 10 })).toEqual([]);
    expect(await revealVariable(t.db, keys, w.at.project, v.id)).toBeUndefined();
    expect(
      await setVariable(t.db, keys, w.at.project, v.id, { value: "no", actor }),
    ).toBeUndefined();
    expect(await listVersions(t.db, w.at.project, v.id, { limit: 10 })).toEqual([]);

    const [row] = await t.db.execute(
      sql`SELECT deleted_at, (SELECT count(*) FROM variable_versions WHERE variable_id = ${v.id}) AS versions FROM variables WHERE id = ${v.id}`,
    );
    expect(Number((row as { versions: string }).versions)).toBe(2);
    expect((row as { deleted_at: Date }).deleted_at).toBeInstanceOf(Date);

    const again = await make(w.at.project, { key: "GONE", value: "fresh" });
    expect(again.id).not.toBe(v.id);
    expect(again.currentVersion).toBe(1);

    for (const scope of [w.at.org, w.at.env]) {
      const first = await make(scope, { key: "GONE" });
      expect(await deleteVariable(t.db, scope, first.id)).toBe(true);
      expect((await make(scope, { key: "GONE" })).id).not.toBe(first.id);
    }
  });

  test("project, environment and organization removal take their variables with them", async () => {
    const w = await world();
    const inProject = await make(w.at.project);
    const inEnv = await make(w.at.env);
    const inOther = await make({ ...w.at.env, environmentId: w.other.id });
    const inOrg = await make(w.at.org);
    const count = async (table: string) =>
      Number(
        ((await t.db.execute(sql.raw(`SELECT count(*) AS n FROM ${table}`)))[0] as { n: string }).n,
      );
    const [variablesBefore, versionsBefore] = [
      await count("variables"),
      await count("variable_versions"),
    ];

    expect(await deleteEnvironment(t.db, w.org.id, w.project.id, w.env.id)).toBe(true);
    expect(await getVariable(t.db, keys, w.at.project, inEnv.id)).toBeUndefined();
    expect(await getVariable(t.db, keys, w.at.project, inProject.id)).toBeDefined();
    expect(await count("variables")).toBe(variablesBefore - 1);
    expect(await count("variable_versions")).toBe(versionsBefore - 1);

    expect(await deleteProject(t.db, w.org.id, w.project.id)).toBe(true);
    const left = await t.db.execute(
      sql`SELECT id FROM variables WHERE id IN (${inProject.id}, ${inOther.id})`,
    );
    expect(left).toHaveLength(0);
    const keysLeft = await t.db.execute(
      sql`SELECT 1 FROM variable_keys WHERE project_id = ${w.project.id}`,
    );
    expect(keysLeft).toHaveLength(0);
    expect(await getVariable(t.db, keys, w.at.org, inOrg.id)).toBeDefined(); // the org's own stay

    expect(await deleteOrganization(t.db, w.org.id)).toBe(true);
    const orgLeft = await t.db.execute(sql`SELECT 1 FROM variables WHERE id = ${inOrg.id}`);
    const orgKeys = await t.db.execute(
      sql`SELECT 1 FROM variable_keys WHERE organization_id = ${w.org.id}`,
    );
    expect([orgLeft.length, orgKeys.length]).toEqual([0, 0]);
  });
});

describe("the chain an environment resolves from", () => {
  test("holds the org, project and environment variables, live and decrypted, nothing else", async () => {
    const w = await world();
    const w2 = await world();
    const org = await make(w.at.org, { key: "ORG", kind: "plain", value: "org-v" });
    const proj = await make(w.at.project, { key: "PROJ", kind: "secret", value: "proj-v" });
    const env = await make(w.at.env, { key: "ENV", kind: "file", value: "env-v" });
    const shadow = await make(w.at.project, { key: "ORG", kind: "plain", value: "shadow" });
    await make({ ...w.at.env, environmentId: w.other.id }, { key: "OTHER_ENV", value: "no" });
    await make(w2.at.project, { key: "OTHER_PROJECT", value: "no" });
    await make(w2.at.org, { key: "OTHER_ORG", value: "no" });
    const sibling = await createProject(t.db, { organizationId: w.org.id, name: "sibling" });
    await make(
      { organizationId: w.org.id, projectId: sibling.id },
      { key: "SIBLING", value: "no" },
    );
    const deleted = await make(w.at.project, { key: "DELETED", value: "no" });
    await deleteVariable(t.db, w.at.project, deleted.id);
    await setVariable(t.db, keys, w.at.project, proj.id, { value: "proj-v2", actor });

    const chain = await openChain(t.db, keys, w.at.env);
    const by = (level: string) => chain.filter((r) => r.level === level);
    expect(by("organization")).toEqual([
      {
        id: org.id,
        level: "organization",
        key: "ORG",
        kind: "plain",
        value: "org-v",
        version: 1,
        tags: [],
      },
    ]);
    // the version is what a later check uses to see that a variable has changed
    expect(by("project").map((r) => [r.id, r.key, r.value, r.version])).toEqual(
      [
        [shadow.id, "ORG", "shadow", 1],
        [proj.id, "PROJ", "proj-v2", 2],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(by("environment")).toEqual([
      {
        id: env.id,
        level: "environment",
        key: "ENV",
        kind: "file",
        value: "env-v",
        version: 1,
        tags: [],
      },
    ]);
    expect(chain).toHaveLength(4);

    const noEnv = await openChain(t.db, keys, w.at.project);
    expect(noEnv.map((r) => r.level).sort()).toEqual(["organization", "project", "project"]);
  });

  test("fails whole when one value does not open", async () => {
    const w = await world();
    await make(w.at.project);
    const other = envKeyProvider(`k9:${key(9)}`);
    await expect(openChain(t.db, other, w.at.env)).rejects.toBeInstanceOf(CryptoError);
  });

  test("chainKeys names what applies to an environment, once each, without opening a value", async () => {
    const w = await world();
    const w2 = await world();
    await make(w.at.org, { key: "ORG", kind: "plain" });
    await make(w.at.org, { key: "SHARED" });
    await make(w.at.project, { key: "SHARED" });
    await make(w.at.project, { key: "PROJ" });
    await make(w.at.env, { key: "ENV" });
    await make({ ...w.at.env, environmentId: w.other.id }, { key: "OTHER_ENV" });
    await make(w2.at.project, { key: "OTHER_PROJECT" });
    await make(w2.at.org, { key: "OTHER_ORG" });
    const gone = await make(w.at.project, { key: "GONE" });
    await deleteVariable(t.db, w.at.project, gone.id);

    expect(await chainKeys(t.db, w.at.env)).toEqual(["ENV", "ORG", "PROJ", "SHARED"]);
    expect(await chainKeys(t.db, { ...w.at.env, environmentId: w.other.id })).toEqual([
      "ORG",
      "OTHER_ENV",
      "PROJ",
      "SHARED",
    ]);
    // a project with no environment named: the organization's and the project's own
    expect(await chainKeys(t.db, w.at.project)).toEqual(["ORG", "PROJ", "SHARED"]);
  });
});

describe("bulk edit", () => {
  const set = (
    key: string,
    value: string,
    kind: "plain" | "secret" | "file" = "secret",
  ): BulkOp => ({
    op: "set",
    key,
    kind,
    value,
  });
  const run = (scope: Scope, ops: BulkOp[]) => bulkLevel(t.db, keys, scope, ops, { actor });
  const brief = (done: Awaited<ReturnType<typeof run>>) =>
    done.map((d) => `${d.change} ${d.key}${d.to ? `>${d.to}` : ""} ${d.applied}`);

  test("makes, changes, renames and deletes in one go, keeps history, and a second run changes nothing", async () => {
    const w = await world();
    await make(w.at.project, { key: "KEEP", value: "k" });
    const old = await make(w.at.project, { key: "OLD", value: "o" });
    const gone = await make(w.at.project, { key: "GONE", value: "g" });
    const chg = await make(w.at.project, { key: "CHG", value: "1" });
    const ops: BulkOp[] = [
      set("NEW", "n", "plain"),
      set("CHG", "2"),
      set("KEEP", "k"),
      { op: "rename", key: "OLD", to: "FRESH" },
      { op: "delete", key: "GONE" },
    ];

    const done = await run(w.at.project, ops);
    expect(brief(done)).toEqual([
      "update CHG true",
      "delete GONE true",
      "unchanged KEEP false",
      "create NEW true",
      "rename OLD>FRESH true",
    ]);
    expect(done.find((d) => d.change === "rename")?.variable?.key).toBe("FRESH");
    expect(JSON.stringify(done)).not.toContain('"value"');

    const renamed = await revealVariable(t.db, keys, w.at.project, old.id);
    expect([renamed?.variable.key, renamed?.version, renamed?.value]).toEqual(["FRESH", 1, "o"]);
    expect(await getVariable(t.db, keys, w.at.project, gone.id)).toBeUndefined();
    const versions = await listVersions(t.db, w.at.project, chg.id, { limit: 10 });
    expect(versions.map((v) => [v.version, v.reason])).toEqual([
      [2, "bulk edit"],
      [1, null],
    ]);

    const again = await run(w.at.project, ops);
    expect(brief(again)).toEqual([
      "unchanged CHG false",
      "missing GONE false",
      "unchanged KEEP false",
      "unchanged NEW false",
      "missing OLD false",
    ]);
    expect(await code(make(w.at.project, { key: "OLD" }))).toBeUndefined(); // the old key is free
    expect(await code(make(w.at.project, { key: "GONE" }))).toBeUndefined();
  });

  test("a rename onto a held key, a key of another kind and a missing key are left alone", async () => {
    const w = await world();
    const a = await make(w.at.project, { key: "A", value: "a" });
    await make(w.at.project, { key: "B", value: "b" });
    await make(w.at.project, { key: "P", kind: "plain", value: "p" });
    const done = await run(w.at.project, [
      { op: "rename", key: "A", to: "B" },
      set("P", "x"),
      { op: "delete", key: "NOPE" },
    ]);
    expect(brief(done)).toEqual([
      "conflict A>B false",
      "missing NOPE false",
      "kind_mismatch P false",
    ]);
    expect((await getVariable(t.db, keys, w.at.project, a.id))?.key).toBe("A");
  });

  test("works on one level only: the same key one level up or down is untouched", async () => {
    const w = await world();
    const up = await make(w.at.org, { key: "SAME", value: "up" });
    const mid = await make(w.at.project, { key: "SAME", value: "mid" });
    const low = await make(w.at.env, { key: "SAME", value: "low" });
    await run(w.at.project, [{ op: "delete", key: "SAME" }]);
    expect(await getVariable(t.db, keys, w.at.project, mid.id)).toBeUndefined();
    expect((await getVariable(t.db, keys, w.at.org, up.id))?.key).toBe("SAME");
    expect((await getVariable(t.db, keys, w.at.env, low.id))?.key).toBe("SAME");
  });

  test("one step that fails undoes the others", async () => {
    const w = await world();
    const a = await make(w.at.project, { key: "A", value: "a" });
    const bad = run(w.at.project, [
      { op: "rename", key: "A", to: "Z" },
      set("lower case", "x"), // not an environment variable name: a check violation
    ]);
    expect(await code(bad)).toBe("23514");
    expect((await getVariable(t.db, keys, w.at.project, a.id))?.key).toBe("A");
    expect(await listVariables(t.db, keys, w.at.project, { limit: 10 })).toHaveLength(1);
  });
});

describe("search", () => {
  const find = (
    w: Awaited<ReturnType<typeof world>>,
    over: Partial<Parameters<typeof searchVariables>[2]> = {},
  ) =>
    searchVariables(t.db, keys, { organizationId: w.org.id, projects: true, limit: 50, ...over });
  const seed = async () => {
    const w = await world();
    await make(w.at.org, { key: "DB_URL", kind: "plain", value: "postgres://org" });
    await make(w.at.project, { key: "db_pool", kind: "plain", value: "10" });
    await make(w.at.project, { key: "DB_PASSWORD", kind: "secret", value: `pw-${CANARY}` });
    await make(w.at.env, { key: "API_URL", kind: "plain", value: "https://api.example" });
    await make(w.at.env, { key: "A_B", kind: "plain", value: "100%_sure" });
    return w;
  };
  const keysOf = (r: Awaited<ReturnType<typeof find>>) => r.items.map((v) => v.key);

  test("finds by part of the key, in any case, over every level, ordered by key", async () => {
    const w = await seed();
    expect(keysOf(await find(w, { key: "db" })).sort()).toEqual([
      "DB_PASSWORD",
      "DB_URL",
      "db_pool",
    ]); // the order is the database's collation
    expect(keysOf(await find(w, { key: "_URL" }))).toEqual(["API_URL", "DB_URL"]);
    expect(keysOf(await find(w, { key: "zzz" }))).toEqual([]);
    expect(keysOf(await find(w))).toHaveLength(5);
  });

  test("% and _ are what they are, not wildcards", async () => {
    const w = await seed();
    expect(keysOf(await find(w, { key: "_" }))).toHaveLength(5); // every key has one
    expect(keysOf(await find(w, { key: "%" }))).toEqual([]);
    expect(keysOf(await find(w, { key: "A_B" }))).toEqual(["A_B"]);
    expect(keysOf(await find(w, { value: "%_" }))).toEqual(["A_B"]);
    expect(keysOf(await find(w, { value: "0%" }))).toEqual(["A_B"]);
    expect(keysOf(await find(w, { value: "0_" }))).toEqual([]);
  });

  test("a value is looked for in plain variables only, case-sensitively; a secret is never opened", async () => {
    const w = await seed();
    expect(keysOf(await find(w, { value: "postgres" }))).toEqual(["DB_URL"]);
    expect(keysOf(await find(w, { value: "POSTGRES" }))).toEqual([]);
    expect(keysOf(await find(w, { value: "api.example" }))).toEqual(["API_URL"]);
    expect(await find(w, { value: CANARY })).toEqual({ items: [], more: false });
    expect(await find(w, { value: CANARY, kind: "secret" })).toEqual({ items: [], more: false });
    expect(await find(w, { value: "postgres", kind: "secret" })).toEqual({
      items: [],
      more: false,
    });
    // with the key gone nothing could be opened: proof the search did not need to
    const none = envKeyProvider(`k9:${key(9)}`);
    const secretsOnly = await searchVariables(t.db, none, {
      organizationId: w.org.id,
      projects: true,
      kind: "secret",
      limit: 10,
    });
    expect(keysOf(secretsOnly)).toEqual(["DB_PASSWORD"]);
    expect(secretsOnly.items[0]?.value).toBeNull();
  });

  test("kind narrows, projects: false keeps the organization's own, and plain values come back", async () => {
    const w = await seed();
    expect(keysOf(await find(w, { kind: "secret" }))).toEqual(["DB_PASSWORD"]);
    const own = await find(w, { projects: false });
    expect(own.items.map((v) => [v.key, v.value])).toEqual([["DB_URL", "postgres://org"]]);
    expect(keysOf(await find(w, { key: "pool", projects: false }))).toEqual([]);
  });

  test("never leaves the organization, and skips what is deleted", async () => {
    const w = await seed();
    const w2 = await seed();
    const gone = await make(w.at.project, { key: "DB_GONE", kind: "plain", value: "x" });
    await deleteVariable(t.db, w.at.project, gone.id);
    expect(keysOf(await find(w, { key: "gone" }))).toEqual([]);
    expect((await find(w, { key: "db" })).items.every((v) => v.organizationId === w.org.id)).toBe(
      true,
    );
    expect((await find(w2, { key: "db" })).items.every((v) => v.organizationId === w2.org.id)).toBe(
      true,
    );
  });

  test("a full page says there is more, an exact one does not", async () => {
    const w = await seed();
    const page = await find(w, { key: "db", limit: 2 });
    expect([keysOf(page), page.more]).toEqual([["DB_PASSWORD", "DB_URL"], true]);
    const exact = await find(w, { key: "db", limit: 3 });
    expect([keysOf(exact).length, exact.more]).toEqual([3, false]);
  });

  test("a search by value stops after its scan and says so", async () => {
    const w = await world();
    for (const k of ["A1", "A2", "A3", "A4"])
      await make(w.at.project, { key: k, kind: "plain", value: "hit" });
    const cut = await find(w, { value: "hit", scan: 2 });
    expect([keysOf(cut), cut.more]).toEqual([["A1", "A2"], true]);
    const whole = await find(w, { value: "hit", scan: 4 });
    expect([keysOf(whole).length, whole.more]).toEqual([4, false]);
    const limited = await find(w, { value: "hit", scan: 4, limit: 3 });
    expect([keysOf(limited).length, limited.more]).toEqual([3, true]);
  });

  test("secrets and files do not use up the scan of a search by value", async () => {
    const w = await world();
    for (const k of ["A1", "A2", "A3"])
      await make(w.at.project, { key: k, kind: "secret", value: "hit" });
    await make(w.at.project, { key: "B1", kind: "plain", value: "hit" });
    const found = await find(w, { value: "hit", scan: 1 });
    expect([keysOf(found), found.more]).toEqual([["B1"], false]);
  });
});

describe("the changes of a project", () => {
  const edit = (scope: Scope, id: string, value: string, reason?: string) =>
    setVariable(t.db, keys, scope, id, { value, actor, ...(reason ? { reason } : {}) });
  const seed = async () => {
    const w = await world();
    const a = await make(w.at.project, { key: "A", kind: "plain", value: "PLAIN-VALUE-one" });
    const b = await make(w.at.env, { key: "B", kind: "secret", value: CANARY });
    const c = await make(w.at.project, { key: "C", kind: "plain", value: "c1" });
    await edit(w.at.project, a.id, "PLAIN-VALUE-two", "tidy");
    await edit(w.at.env, b.id, `${CANARY}-2`);
    const sibling = await make(
      { ...w.at.env, environmentId: w.other.id },
      { key: "D", kind: "plain", value: "d1" },
    );
    const orgLevel = await make(w.at.org, { key: "ORG", kind: "plain", value: "o1" });
    return { w, a, b, c, sibling, orgLevel };
  };
  const rows = (
    w: Awaited<ReturnType<typeof world>>,
    f: { environmentId?: string } = {},
    page: { limit: number; after?: string } = { limit: 50 },
  ) => listVariableChanges(t.db, w.at.project, f, page);
  const label = (r: { key: string; version: number }) => `${r.key}@${r.version}`;

  test("one row for each version written, newest first, with who, when and why", async () => {
    const { w } = await seed();
    const all = await rows(w);
    expect(all.map(label)).toEqual(["D@1", "B@2", "A@2", "C@1", "B@1", "A@1"]);
    expect(all.find((r) => label(r) === "A@2")).toMatchObject({
      kind: "plain",
      projectId: w.project.id,
      environmentId: null,
      actorKind: "user",
      actorId: "u1",
      reason: "tidy",
    });
    expect(all.find((r) => label(r) === "B@1")?.environmentId).toBe(w.env.id);
    expect(all[0]?.createdAt).toBeInstanceOf(Date);
  });

  test("a page continues after the id of the last row, and an exact page ends the list", async () => {
    const { w } = await seed();
    const first = await rows(w, {}, { limit: 4 });
    expect(first.map(label)).toEqual(["D@1", "B@2", "A@2", "C@1"]);
    const next = await rows(w, {}, { limit: 4, after: first.at(-1)?.id as string });
    expect(next.map(label)).toEqual(["B@1", "A@1"]);
    const none = await rows(w, {}, { limit: 4, after: next.at(-1)?.id as string });
    expect(none).toEqual([]);
  });

  test("an environment sees its own and the project's, not a sibling's and not the organization's", async () => {
    const { w } = await seed();
    expect((await rows(w, { environmentId: w.env.id })).map(label)).toEqual([
      "B@2",
      "A@2",
      "C@1",
      "B@1",
      "A@1",
    ]);
    expect((await rows(w, { environmentId: w.other.id })).map(label)).toEqual([
      "D@1",
      "A@2",
      "C@1",
      "A@1",
    ]);
    // without an environment: the whole project, and still nothing of the organization's level
    expect((await rows(w)).map((r) => r.key)).not.toContain("ORG");
  });

  test("another project or organization never appears, and nor does a deleted variable", async () => {
    const { w, c } = await seed();
    const w2 = await world();
    await make(w2.at.project, { key: "FOREIGN", kind: "plain", value: "x" });
    await make(w2.at.env, { key: "FOREIGN_ENV", kind: "plain", value: "x" });
    const second = await createProject(t.db, { organizationId: w.org.id, name: "second" });
    await make(
      { organizationId: w.org.id, projectId: second.id },
      { key: "SIBLING", kind: "plain", value: "x" },
    );
    expect((await rows(w)).map((r) => r.key)).not.toContain("FOREIGN");
    expect((await rows(w)).map((r) => r.key)).not.toContain("FOREIGN_ENV");
    expect((await rows(w)).map((r) => r.key)).not.toContain("SIBLING");
    // an environment of another project is no filter that finds this project's rows
    expect(await rows(w, { environmentId: w2.env.id })).toHaveLength(3);
    expect(
      (await listVariableChanges(t.db, w2.at.project, {}, { limit: 50 })).map((r) => r.key),
    ).toEqual(["FOREIGN_ENV", "FOREIGN"]);
    // a project id under the wrong organization finds nothing
    expect(
      await listVariableChanges(
        t.db,
        { organizationId: w2.org.id, projectId: w.project.id },
        {},
        { limit: 50 },
      ),
    ).toEqual([]);
    await deleteVariable(t.db, w.at.project, c.id);
    expect((await rows(w)).map((r) => r.key)).not.toContain("C");
  });

  test("no row carries a value, a ciphertext or a data key", async () => {
    const { w } = await seed();
    const all = await rows(w);
    expect(Object.keys(all[0] ?? {}).sort()).toEqual(
      [
        "actorId",
        "actorKind",
        "createdAt",
        "environmentId",
        "folder",
        "id",
        "key",
        "kind",
        "projectId",
        "reason",
        "variableId",
        "version",
      ].sort(),
    );
    expect(JSON.stringify(all)).not.toContain(CANARY);
    expect(JSON.stringify(all)).not.toContain("PLAIN-VALUE");
  });
});

describe("variables in folders", () => {
  const mkdir = async (w: Awaited<ReturnType<typeof world>>, path: string) => {
    const at = path.lastIndexOf("/");
    const made = await createFolder(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      parent: at === 0 ? "/" : path.slice(0, at),
      name: path.slice(at + 1),
    });
    if (!("row" in made)) throw new Error(`no folder: ${made.error}`);
    return made.row;
  };
  const inFolder = (scope: Scope, folder: string, k: string, value = "v") =>
    createVariable(t.db, keys, { ...scope, key: k, kind: "plain", value, folder, actor });
  const constraint = async (p: Promise<unknown>) => pgConstraint(await p.catch((e) => e));

  test("a move keeps the variable and its versions, and only its own level can make it", async () => {
    const w = await world();
    await mkdir(w, "/db");
    const v = await make(w.at.project, { key: "M", kind: "plain", value: "one" });
    // another level's scope does not reach it, and a variable that is not there is not moved
    const folderNow = async () => (await getVariable(t.db, keys, w.at.project, v.id))?.folder;
    expect(await moveVariable(t.db, keys, w.at.env, v.id, "/db")).toBeUndefined();
    expect(await folderNow()).toBe("/");
    await moveVariable(t.db, keys, w.at.project, v.id, "/db");
    expect(await moveVariable(t.db, keys, w.at.org, v.id, "/")).toBeUndefined();
    expect(await folderNow()).toBe("/db");
    expect(
      await moveVariable(t.db, keys, w.at.project, "00000000-0000-4000-8000-000000000000", "/db"),
    ).toBeUndefined();
    await moveVariable(t.db, keys, w.at.project, v.id, "/");
    // a folder that is not there is an error, and nothing moves
    await expect(moveVariable(t.db, keys, w.at.project, v.id, "/nope")).rejects.toBeInstanceOf(
      FolderNotFoundError,
    );
    const moved = await moveVariable(t.db, keys, w.at.project, v.id, "/db");
    expect(moved).toMatchObject({ id: v.id, folder: "/db", currentVersion: v.currentVersion });
    expect(await listVersions(t.db, w.at.project, v.id, { limit: 5 })).toHaveLength(1);
  });

  test("a variable says which folder it is in: / for the root", async () => {
    const w = await world();
    await mkdir(w, "/db");
    const root = await make(w.at.project, { key: "A", kind: "plain" });
    const deep = await inFolder(w.at.project, "/db", "A");
    expect(root.folder).toBe("/");
    expect(deep.folder).toBe("/db");
    expect((await getVariable(t.db, keys, w.at.project, deep.id))?.folder).toBe("/db");
    expect((await revealVariable(t.db, keys, w.at.project, deep.id))?.variable.folder).toBe("/db");
  });

  test("a key is held once per folder at each level, and the root counts as one folder", async () => {
    const w = await world();
    await mkdir(w, "/a");
    await mkdir(w, "/b");
    for (const scope of [w.at.project, w.at.env]) {
      await make(scope, { key: "K", kind: "plain" });
      await inFolder(scope, "/a", "K");
      await inFolder(scope, "/b", "K");
      const index = scope === w.at.env ? "variables_environment_key" : "variables_project_key";
      expect(await constraint(make(scope, { key: "K", kind: "plain" }))).toBe(index);
      expect(await constraint(inFolder(scope, "/a", "K"))).toBe(index);
    }
    await make(w.at.org, { key: "K", kind: "plain" });
    expect(await constraint(make(w.at.org, { key: "K", kind: "plain" }))).toBe("variables_org_key");
  });

  test("a root key is unique for whoever writes it: a null folder is a value, not a gap", async () => {
    const w = await world();
    const row = {
      organizationId: w.org.id,
      projectId: w.project.id,
      key: "RAW",
      kind: "plain" as const,
      folderId: null,
    };
    await t.db.insert(variables).values(row);
    expect(await constraint(t.db.insert(variables).values(row))).toBe("variables_project_key");
  });

  test("an organization variable has no folder, however it is written", async () => {
    const w = await world();
    const a = await mkdir(w, "/a");
    expect(
      await constraint(
        t.db.insert(variables).values({
          organizationId: w.org.id,
          key: "ORG",
          kind: "plain",
          folderId: a.id,
        }),
      ),
    ).toBe("variables_folder_check");
    // through the function it is a folder that is not there: an organization has none
    const refused = await inFolder(w.at.org, "/a", "ORG").catch((e: Error) => e.name);
    expect(refused).toBe("FolderNotFoundError");
  });

  test("a variable cannot be in another project's folder, a deleted folder or one that is not there", async () => {
    const w = await world();
    const theirs = await world();
    const folder = await mkdir(theirs, "/theirs");
    await mkdir(w, "/gone");
    await t.db
      .update(variableFolders)
      .set({ deletedAt: new Date() })
      .where(eq(variableFolders.path, "/gone"));
    expect(
      await constraint(
        t.db.insert(variables).values({
          organizationId: w.org.id,
          projectId: w.project.id,
          key: "X",
          kind: "plain",
          folderId: folder.id,
        }),
      ),
    ).toBe("variables_folder_fk");
    for (const path of ["/theirs", "/gone", "/nope"]) {
      expect(await inFolder(w.at.project, path, "X").catch((e: Error) => e.name)).toBe(
        "FolderNotFoundError",
      );
    }
    expect(await listVariables(t.db, keys, w.at.project, { limit: 10 })).toEqual([]);
  });

  test("a deleted variable keeps its folder and frees its key there", async () => {
    const w = await world();
    const folder = await mkdir(w, "/a");
    const v = await inFolder(w.at.project, "/a", "K");
    await deleteVariable(t.db, w.at.project, v.id);
    const [row] = await t.db.select().from(variables).where(eq(variables.id, v.id));
    expect(row?.folderId).toBe(folder.id);
    expect((await inFolder(w.at.project, "/a", "K")).id).not.toBe(v.id);
  });

  test("a list shows one folder, the root unless told otherwise; a search shows where each one is", async () => {
    const w = await world();
    await mkdir(w, "/a");
    await mkdir(w, "/a/b");
    const root = await make(w.at.project, { key: "R", kind: "plain" });
    const a = await inFolder(w.at.project, "/a", "A");
    const ab = await inFolder(w.at.project, "/a/b", "AB");
    const envA = await inFolder(w.at.env, "/a", "E");
    const ids = async (scope: Scope, folder?: string) =>
      (await listVariables(t.db, keys, scope, { limit: 10 }, folder)).map((v) => v.id);
    expect(await ids(w.at.project)).toEqual([root.id]);
    expect(await ids(w.at.project, "/")).toEqual([root.id]);
    expect(await ids(w.at.project, "/a")).toEqual([a.id]);
    expect(await ids(w.at.project, "/a/b")).toEqual([ab.id]);
    expect(await ids(w.at.env)).toEqual([]);
    expect(await ids(w.at.env, "/a")).toEqual([envA.id]);
    const found = await searchVariables(t.db, keys, {
      organizationId: w.org.id,
      projects: true,
      limit: 10,
    });
    expect(found.items.map((v) => [v.key, v.folder])).toEqual([
      ["A", "/a"],
      ["AB", "/a/b"],
      ["E", "/a"],
      ["R", "/"],
    ]);
  });

  test("the chain carries a variable's folder, and none for one at the root", async () => {
    const w = await world();
    await mkdir(w, "/db");
    await make(w.at.project, { key: "R", kind: "plain" });
    await inFolder(w.at.project, "/db", "URL");
    await inFolder(w.at.env, "/db", "PASS");
    const chain = await openChain(t.db, keys, w.at.env);
    expect(chain.map((e) => [e.key, e.folder]).sort()).toEqual([
      ["PASS", "/db"],
      ["R", undefined],
      ["URL", "/db"],
    ]);
    expect("folder" in (chain.find((e) => e.key === "R") ?? {})).toBe(false);
  });

  test("chainKeys names what is set at the root, not what is only in a folder", async () => {
    const w = await world();
    await mkdir(w, "/db");
    await make(w.at.project, { key: "R", kind: "plain" });
    await inFolder(w.at.project, "/db", "URL");
    expect(await chainKeys(t.db, w.at.env)).toEqual(["R"]);
  });

  test("a bulk edit of the root leaves a folder's variable of the same key alone", async () => {
    const w = await world();
    await mkdir(w, "/a");
    const inA = await inFolder(w.at.project, "/a", "K", "in-a");
    const done = await bulkLevel(
      t.db,
      keys,
      w.at.project,
      [{ op: "set", key: "K", value: "root" }],
      {
        actor,
      },
    );
    expect(done.map((d) => [d.change, d.applied])).toEqual([["create", true]]);
    await bulkLevel(t.db, keys, w.at.project, [{ op: "delete", key: "K" }], { actor });
    expect((await getVariable(t.db, keys, w.at.project, inA.id))?.value).toBe("in-a");
  });
});
