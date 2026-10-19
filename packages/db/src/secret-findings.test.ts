import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ParsedFinding } from "@orch/core";
import { eq, getTableColumns } from "drizzle-orm";
import { pgConstraint } from "./pg-error";
import { createOrganization, createProject, deleteProject } from "./repo";
import { secretFindings } from "./schema";
import {
  countOpenFindings,
  dismissFinding,
  getFinding,
  getSecretGate,
  listFindings,
  reopenFinding,
  resolveMissing,
  setSecretGate,
  upsertFindings,
} from "./secret-findings";
import { createTestDb, type TestDb } from "./testing";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const T0 = new Date("2026-03-01T12:00:00Z");
const hours = (n: number) => new Date(T0.getTime() + n * 3_600_000);

let n = 0;
const world = async () => {
  const org = await createOrganization(t.db, { slug: `f${++n}`, name: "F" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${n}` });
  return { org, project, scope: { organizationId: org.id, projectId: project.id } };
};
const finding = (fingerprint: string, over: Partial<ParsedFinding> = {}): ParsedFinding => ({
  fingerprint,
  rule: "aws-access-token",
  path: "src/config.ts",
  line: 12,
  commit: "a1b2c3d",
  severity: "critical",
  ...over,
});
const all = (w: Awaited<ReturnType<typeof world>>, opts: { status?: "open" } = {}) =>
  listFindings(t.db, w.org.id, w.project.id, { limit: 100 }, opts);

describe("secret findings", () => {
  test("the table holds where a finding is and never what it is", () => {
    expect(Object.keys(getTableColumns(secretFindings)).sort()).toEqual([
      "commit",
      "createdAt",
      "dismissedAt",
      "dismissedBy",
      "dismissedReason",
      "fingerprint",
      "firstSeenAt",
      "id",
      "lastSeenAt",
      "line",
      "organizationId",
      "path",
      "projectId",
      "ref",
      "rule",
      "severity",
      "status",
      "updatedAt",
    ]);
  });

  test("the same finding upserts once and keeps when it was first seen", async () => {
    const w = await world();
    await upsertFindings(t.db, {
      ...w.scope,
      ref: "main",
      findings: [finding("f1")],
      at: hours(0),
    });
    await upsertFindings(t.db, {
      ...w.scope,
      ref: "main",
      findings: [finding("f1", { line: 40, severity: "high", commit: "d4e5f6a" })],
      at: hours(5),
    });
    const rows = await all(w);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fingerprint: "f1",
      status: "open",
      line: 40,
      severity: "high",
      commit: "d4e5f6a",
      ref: "main",
      firstSeenAt: hours(0),
      lastSeenAt: hours(5),
    });
  });

  test("an empty report stores nothing, and a duplicate inside one report is one finding", async () => {
    const w = await world();
    await upsertFindings(t.db, { ...w.scope, ref: "main", findings: [] });
    expect(await all(w)).toHaveLength(0);
    await upsertFindings(t.db, {
      ...w.scope,
      ref: "main",
      findings: [finding("f1"), finding("f1", { line: 3 })],
    });
    expect(await all(w)).toHaveLength(1);
  });

  test("a finding in another project or organization is invisible", async () => {
    const a = await world();
    const b = await world();
    const sibling = await createProject(t.db, { organizationId: a.org.id, name: "sibling" });
    await upsertFindings(t.db, { ...a.scope, ref: "main", findings: [finding("f1")] });
    // the same fingerprint in another project is its own finding
    await upsertFindings(t.db, { ...b.scope, ref: "main", findings: [finding("f1")] });

    const [mine] = await all(a);
    expect(mine).toBeDefined();
    expect(await listFindings(t.db, a.org.id, sibling.id, { limit: 100 })).toEqual([]);
    expect(await listFindings(t.db, b.org.id, a.project.id, { limit: 100 })).toEqual([]);
    expect(await getFinding(t.db, a.org.id, a.project.id, mine?.id ?? "")).toBeDefined();
    expect(await getFinding(t.db, a.org.id, sibling.id, mine?.id ?? "")).toBeUndefined();
    expect(await getFinding(t.db, b.org.id, a.project.id, mine?.id ?? "")).toBeUndefined();
    expect(await all(b)).toHaveLength(1);
  });

  test("a project outside its organization cannot hold findings", async () => {
    const a = await world();
    const b = await world();
    const err = await upsertFindings(t.db, {
      organizationId: b.org.id,
      projectId: a.project.id,
      ref: "main",
      findings: [finding("f1")],
    }).catch((e) => e);
    expect(pgConstraint(err)).toBe("secret_findings_project_org_fk");
  });

  test("findings page by cursor in creation order and filter by status", async () => {
    const w = await world();
    await upsertFindings(t.db, {
      ...w.scope,
      ref: "main",
      findings: ["a", "b", "c"].map((f) => finding(f)),
    });
    const first = await listFindings(t.db, w.org.id, w.project.id, { limit: 2 });
    const rest = await listFindings(t.db, w.org.id, w.project.id, {
      limit: 2,
      after: first[1]?.id ?? "",
    });
    expect(first).toHaveLength(2);
    expect(rest).toHaveLength(1);
    expect([...first, ...rest].map((r) => r.fingerprint).sort()).toEqual(["a", "b", "c"]);

    await resolveMissing(t.db, { ...w.scope, ref: "main", seen: ["a"] });
    expect((await all(w, { status: "open" })).map((r) => r.fingerprint)).toEqual(["a"]);
  });

  describe("resolve missing", () => {
    test("on the default branch an open finding that the report no longer has is resolved", async () => {
      const w = await world();
      await upsertFindings(t.db, {
        ...w.scope,
        ref: "main",
        findings: [finding("keep"), finding("gone")],
      });
      expect(await resolveMissing(t.db, { ...w.scope, ref: "main", seen: ["keep"] })).toBe(1);
      const byPrint = Object.fromEntries((await all(w)).map((r) => [r.fingerprint, r.status]));
      expect(byPrint).toEqual({ keep: "open", gone: "resolved" });
      // nothing left to resolve
      expect(await resolveMissing(t.db, { ...w.scope, ref: "main", seen: ["keep"] })).toBe(0);
    });

    test("an empty report resolves every open default-branch finding", async () => {
      const w = await world();
      await upsertFindings(t.db, {
        ...w.scope,
        ref: "main",
        findings: [finding("a"), finding("b")],
      });
      expect(await resolveMissing(t.db, { ...w.scope, ref: "main", seen: [] })).toBe(2);
    });

    test("a scan of another branch resolves nothing, and its own findings are never resolved", async () => {
      const w = await world();
      await upsertFindings(t.db, { ...w.scope, ref: "main", findings: [finding("on-main")] });
      await upsertFindings(t.db, {
        ...w.scope,
        ref: "feature/x",
        findings: [finding("on-branch")],
      });
      expect(await resolveMissing(t.db, { ...w.scope, ref: "feature/x", seen: [] })).toBe(0);
      expect(await resolveMissing(t.db, { ...w.scope, ref: "main", seen: [] })).toBe(1);
      const byPrint = Object.fromEntries((await all(w)).map((r) => [r.fingerprint, r.status]));
      expect(byPrint).toEqual({ "on-main": "resolved", "on-branch": "open" });
    });

    test("a finding that reached the default branch stays its own even when a branch reports it again", async () => {
      const w = await world();
      await upsertFindings(t.db, { ...w.scope, ref: "main", findings: [finding("f1")] });
      await upsertFindings(t.db, { ...w.scope, ref: "feature/x", findings: [finding("f1")] });
      expect((await all(w))[0]?.ref).toBe("main");
      // and the other way: a branch finding that is then found on the default branch moves to it
      await upsertFindings(t.db, { ...w.scope, ref: "feature/y", findings: [finding("f2")] });
      await upsertFindings(t.db, { ...w.scope, ref: "main", findings: [finding("f2")] });
      expect((await all(w)).map((r) => r.ref)).toEqual(["main", "main"]);
    });

    test("a dismissed finding is never resolved, and a resolved one that comes back is open again", async () => {
      const w = await world();
      await upsertFindings(t.db, {
        ...w.scope,
        ref: "main",
        findings: [finding("d"), finding("r")],
      });
      const [d] = await all(w);
      // SCAN-4 owns dismissing; here the row is put in that state by hand
      await t.db
        .update(secretFindings)
        .set({
          status: "dismissed",
          dismissedReason: "test key",
          dismissedBy: "user:u1",
          dismissedAt: new Date(),
        })
        .where(eq(secretFindings.id, d?.id ?? ""));
      await resolveMissing(t.db, { ...w.scope, ref: "main", seen: [] });
      const states = Object.fromEntries((await all(w)).map((r) => [r.fingerprint, r.status]));
      expect(states[d?.fingerprint ?? ""]).toBe("dismissed");
      expect(Object.values(states).sort()).toEqual(["dismissed", "resolved"]);

      await upsertFindings(t.db, {
        ...w.scope,
        ref: "main",
        findings: [finding("d"), finding("r")],
      });
      const again = Object.fromEntries((await all(w)).map((r) => [r.fingerprint, r.status]));
      // the dismissal stands; the resolved one is open again
      expect(again[d?.fingerprint ?? ""]).toBe("dismissed");
      expect(Object.values(again).sort()).toEqual(["dismissed", "open"]);
    });

    test("a resolved finding is reopened by a scan of the default branch only; a branch that has it changes nothing", async () => {
      const w = await world();
      await upsertFindings(t.db, { ...w.scope, ref: "main", findings: [finding("f1")] });
      await resolveMissing(t.db, { ...w.scope, ref: "main", seen: [] });
      await upsertFindings(t.db, {
        ...w.scope,
        ref: "feature/x",
        findings: [finding("f1", { path: "other.ts", line: 99 })],
        at: hours(5),
      });
      const [kept] = await all(w);
      // untouched: still resolved on main, with what the default branch last saw
      expect(kept).toMatchObject({ status: "resolved", ref: "main", path: "src/config.ts" });
      expect(await countOpenFindings(t.db, w.scope)).toBe(0);
      await upsertFindings(t.db, { ...w.scope, ref: "main", findings: [finding("f1")] });
      expect((await all(w))[0]?.status).toBe("open");
    });

    test("the default branch is the project's own", async () => {
      const w = await world();
      const trunk = await createProject(t.db, {
        organizationId: w.org.id,
        name: "trunk",
        defaultBranch: "trunk",
      });
      const scope = { organizationId: w.org.id, projectId: trunk.id };
      await upsertFindings(t.db, { ...scope, ref: "trunk", findings: [finding("f1")] });
      expect(await resolveMissing(t.db, { ...scope, ref: "main", seen: [] })).toBe(0);
      expect(await resolveMissing(t.db, { ...scope, ref: "trunk", seen: [] })).toBe(1);
    });
  });

  describe("dismiss and reopen", () => {
    const seed = async (...prints: string[]) => {
      const w = await world();
      await upsertFindings(t.db, {
        ...w.scope,
        ref: "main",
        findings: prints.map((f) => finding(f)),
      });
      const rows = await all(w);
      const idOf = (print: string) => rows.find((r) => r.fingerprint === print)?.id ?? "";
      return { ...w, idOf, at: (id: string) => ({ ...w.scope, id }) };
    };

    test("an open finding is dismissed with who and why, and reopening clears all three", async () => {
      const w = await seed("f1");
      const out = await dismissFinding(t.db, w.at(w.idOf("f1")), "user:u1", "a test key");
      expect(out).toMatchObject({
        result: "changed",
        finding: { status: "dismissed", dismissedReason: "a test key", dismissedBy: "user:u1" },
      });
      expect(
        (await getFinding(t.db, w.org.id, w.project.id, w.idOf("f1")))?.dismissedAt,
      ).toBeInstanceOf(Date);

      const back = await reopenFinding(t.db, w.at(w.idOf("f1")));
      expect(back).toMatchObject({
        result: "changed",
        finding: { status: "open", dismissedReason: null, dismissedBy: null, dismissedAt: null },
      });
    });

    test("only an open finding is dismissed, and only a dismissed one reopened", async () => {
      const w = await seed("keep", "gone");
      await resolveMissing(t.db, { ...w.scope, ref: "main", seen: ["keep"] });
      expect(await dismissFinding(t.db, w.at(w.idOf("gone")), "user:u1", "x")).toEqual({
        result: "unchanged",
        status: "resolved",
      });
      expect(await reopenFinding(t.db, w.at(w.idOf("gone")))).toEqual({
        result: "unchanged",
        status: "resolved",
      });
      expect(await reopenFinding(t.db, w.at(w.idOf("keep")))).toEqual({
        result: "unchanged",
        status: "open",
      });
      await dismissFinding(t.db, w.at(w.idOf("keep")), "user:u1", "x");
      // the second dismissal does not replace the first one's reason or person
      expect(await dismissFinding(t.db, w.at(w.idOf("keep")), "user:u2", "y")).toEqual({
        result: "unchanged",
        status: "dismissed",
      });
      expect((await getFinding(t.db, w.org.id, w.project.id, w.idOf("keep")))?.dismissedBy).toBe(
        "user:u1",
      );
    });

    test("a finding of another project or organization is not found, and is not changed", async () => {
      const a = await seed("f1");
      const b = await world();
      const sibling = await createProject(t.db, { organizationId: a.org.id, name: "sibling" });
      for (const scope of [
        { organizationId: b.org.id, projectId: a.project.id, id: a.idOf("f1") },
        { organizationId: a.org.id, projectId: sibling.id, id: a.idOf("f1") },
      ]) {
        expect(await dismissFinding(t.db, scope, "user:u1", "x")).toBeUndefined();
        expect(await reopenFinding(t.db, scope)).toBeUndefined();
      }
      expect((await all(a))[0]?.status).toBe("open");
    });

    test("a dismissal that comes back in a report stays dismissed, then reopens and resolves like any", async () => {
      const w = await seed("f1");
      await dismissFinding(t.db, w.at(w.idOf("f1")), "user:u1", "x");
      await reopenFinding(t.db, w.at(w.idOf("f1")));
      expect(await resolveMissing(t.db, { ...w.scope, ref: "main", seen: [] })).toBe(1);
    });
  });

  test("findings go with their project", async () => {
    const w = await world();
    await upsertFindings(t.db, { ...w.scope, ref: "main", findings: [finding("f1")] });
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await all(w)).toEqual([]);
  });

  test("the table refuses a status, severity or fingerprint it does not know", async () => {
    const w = await world();
    const bad = (over: Record<string, unknown>) =>
      t.db
        .insert(secretFindings)
        .values({ ...w.scope, ref: "main", ...finding("ok"), ...over } as never)
        .catch((e) => pgConstraint(e));
    expect(await bad({ status: "ignored" })).toBe("secret_findings_status_check");
    expect(await bad({ severity: "urgent" })).toBe("secret_findings_severity_check");
    expect(await bad({ fingerprint: "has space" })).toBe("secret_findings_fingerprint_check");
    expect(await bad({ line: 0 })).toBe("secret_findings_line_check");
    // dismissed needs its reason and who, and only dismissed carries them
    expect(await bad({ status: "dismissed" })).toBe("secret_findings_dismissal_check");
    expect(await bad({ dismissedReason: "why" })).toBe("secret_findings_dismissal_check");
  });
});

describe("the secret gate setting and the count it judges (SCAN-6)", () => {
  test("an organization's gate is off until it is set, and the previous one comes back from a change", async () => {
    const w = await world();
    expect(await getSecretGate(t.db, w.org.id)).toBe("off");
    expect(await setSecretGate(t.db, w.org.id, "deny")).toEqual({ previous: "off" });
    expect(await getSecretGate(t.db, w.org.id)).toBe("deny");
    expect(await setSecretGate(t.db, w.org.id, "warn")).toEqual({ previous: "deny" });
    expect(await setSecretGate(t.db, w.org.id, "off")).toEqual({ previous: "warn" });
  });

  test("another organization is untouched, and an organization that is not there has none", async () => {
    const a = await world();
    const b = await world();
    await setSecretGate(t.db, a.org.id, "deny");
    expect(await getSecretGate(t.db, b.org.id)).toBe("off");
    const none = "00000000-0000-4000-8000-000000000000";
    expect(await getSecretGate(t.db, none)).toBeUndefined();
    expect(await setSecretGate(t.db, none, "deny")).toBeUndefined();
  });

  test("the table refuses a setting that is not off, warn or deny", async () => {
    const w = await world();
    const err = await setSecretGate(t.db, w.org.id, "block" as never).catch((e) => e);
    expect(pgConstraint(err)).toBe("organizations_secret_gate_check");
    expect(await getSecretGate(t.db, w.org.id)).toBe("off");
  });

  test("counts the open findings seen on the project's default branch, and no others", async () => {
    const w = await world();
    const other = await world();
    const seen = (over: Partial<Parameters<typeof upsertFindings>[1]>) =>
      upsertFindings(t.db, { ...w.scope, ref: "main", findings: [], ...over });
    expect(await countOpenFindings(t.db, w.scope)).toBe(0);
    await seen({
      findings: [finding("open-1"), finding("open-2"), finding("gone"), finding("dis")],
    });
    await seen({ ref: "feature/x", findings: [finding("on-branch")] });
    await resolveMissing(t.db, { ...w.scope, ref: "main", seen: ["open-1", "open-2", "dis"] });
    await dismissFinding(t.db, { ...w.scope, id: await idOf(w, "dis") }, "user:1", "revoked");
    await upsertFindings(t.db, { ...other.scope, ref: "main", findings: [finding("theirs")] });
    // open-1 and open-2 count; gone is resolved, dis is dismissed, on-branch is a branch's, theirs is another project's
    expect(await countOpenFindings(t.db, w.scope)).toBe(2);
    // a finding seen on the default branch stays one when a branch reports it too
    await seen({ ref: "feature/x", findings: [finding("open-1")] });
    expect(await countOpenFindings(t.db, w.scope)).toBe(2);
  });
});

async function idOf(w: Awaited<ReturnType<typeof world>>, fingerprint: string) {
  const f = (await all(w)).find((x) => x.fingerprint === fingerprint);
  if (!f) throw new Error(`no finding ${fingerprint}`);
  return f.id;
}
