import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { aad, CryptoError, encrypt, envKeyProvider, generateDek, wrapDek } from "@orch/crypto";
import { sql } from "drizzle-orm";
import { pgCode, pgConstraint } from "./pg-error";
import {
  createEnvironment,
  createOrganization,
  createProject,
  deleteEnvironment,
  deleteOrganization,
  deleteProject,
} from "./repo";
import { variableKeys, variables, variableVersions } from "./schema";
import { createTestDb, type TestDb } from "./testing";
import {
  createVariable,
  deleteVariable,
  getVariable,
  listVariables,
  listVersions,
  openChain,
  revealVariable,
  type Scope,
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
        "id",
        "key",
        "kind",
        "organizationId",
        "projectId",
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

  test("an id is found only under its own organization and project", async () => {
    const w = await world();
    const w2 = await world();
    const v = await make(w.at.project, { kind: "plain", value: "x" });
    const org = await make(w.at.org, { kind: "plain", value: "y" });
    const reach = [
      w2.at.project, // another org and project
      { organizationId: w.org.id, projectId: w2.project.id }, // right org, wrong project
      w.at.org, // org level does not see project-level rows
    ];
    for (const owner of reach) {
      expect(await getVariable(t.db, keys, owner, v.id)).toBeUndefined();
      expect(await revealVariable(t.db, keys, owner, v.id)).toBeUndefined();
      expect(await setVariable(t.db, keys, owner, v.id, { value: "z", actor })).toBeUndefined();
      expect(await deleteVariable(t.db, owner, v.id)).toBe(false);
      expect(await listVersions(t.db, owner, v.id, { limit: 5 })).toEqual([]);
    }
    expect(await getVariable(t.db, keys, w.at.project, org.id)).toBeUndefined(); // project path, org-level row
    expect((await getVariable(t.db, keys, w.at.project, v.id))?.value).toBe("x");
    // An environment-level variable is reached through its project.
    const e = await make(w.at.env, { kind: "plain", value: "e" });
    expect((await getVariable(t.db, keys, w.at.project, e.id))?.environmentId).toBe(w.env.id);
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
      { id: org.id, level: "organization", key: "ORG", kind: "plain", value: "org-v" },
    ]);
    expect(by("project").map((r) => [r.id, r.key, r.value])).toEqual(
      [
        [shadow.id, "ORG", "shadow"],
        [proj.id, "PROJ", "proj-v2"],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(by("environment")).toEqual([
      { id: env.id, level: "environment", key: "ENV", kind: "file", value: "env-v" },
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
});
