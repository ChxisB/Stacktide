import type { FindingStatus, ParsedFinding, SecretGate } from "@orch/core";
import { and, asc, count, eq, gt, notInArray, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { Executor, Page } from "./repo";
import { organizations, projects, secretFindings } from "./schema";

export type SecretFinding = typeof secretFindings.$inferSelect;

const clock = (at?: Date) => (at ? sql`${at.toISOString()}::timestamptz` : sql`now()`);

export interface FindingsReport {
  organizationId: string;
  projectId: string;
  /** The pipeline's ref. */
  ref: string;
  findings: readonly ParsedFinding[];
  /** Test seam for the seen-at time. Left out, the database clock decides. */
  at?: Date;
}

/**
 * Records what a scan reported, in one statement (the parser keeps a report to 1000). A finding already
 * known is updated in place and keeps `first_seen_at`; one that was resolved is open again when the default
 * branch reports it (the secret is back) and is left untouched by any other branch; an open or dismissed one keeps its status. `ref` moves to this scan's ref, except that a
 * finding once seen on the project's default branch stays a default-branch finding.
 */
export async function upsertFindings(db: Executor, input: FindingsReport) {
  const { organizationId, projectId, ref, at } = input;
  // one row per fingerprint: Postgres refuses to change a row twice in one statement
  const byPrint = new Map(input.findings.map((f) => [f.fingerprint, f]));
  if (byPrint.size === 0) return;
  await db
    .insert(secretFindings)
    .values(
      [...byPrint.values()].map((f) => ({
        organizationId,
        projectId,
        ref,
        ...f,
        firstSeenAt: clock(at),
        lastSeenAt: clock(at),
      })),
    )
    .onConflictDoUpdate({
      target: [secretFindings.projectId, secretFindings.fingerprint],
      set: {
        rule: sql`excluded.rule`,
        path: sql`excluded.path`,
        line: sql`excluded.line`,
        commit: sql`excluded.commit`,
        severity: sql`excluded.severity`,
        lastSeenAt: sql`excluded.last_seen_at`,
        status: sql`case when ${secretFindings.status} = 'resolved' then 'open' else ${secretFindings.status} end`,
        ref: sql`case when ${secretFindings.ref} = (select ${projects.defaultBranch} from ${projects} where ${projects.id} = ${secretFindings.projectId}) then ${secretFindings.ref} else excluded.ref end`,
      },
      // a resolved finding is gone from the default branch: only a scan of that branch brings it back
      setWhere: sql`${secretFindings.status} <> 'resolved' or excluded.ref = (select ${projects.defaultBranch} from ${projects} where ${projects.id} = ${secretFindings.projectId})`,
    });
}

/**
 * After a complete scan of the project's default branch: the open findings it did not report are gone,
 * so they are resolved. Returns how many. A scan of any other ref resolves nothing (a branch that lacks a
 * finding says nothing about the default branch), and a dismissed finding is a person's call, never undone
 * here. The caller passes only reports whose scan finished.
 */
export async function resolveMissing(
  db: Executor,
  input: {
    organizationId: string;
    projectId: string;
    ref: string;
    /** Every fingerprint the report held. */
    seen: readonly string[];
  },
) {
  const { organizationId, projectId, ref, seen } = input;
  const [project] = await db
    .select({ defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)));
  if (project?.defaultBranch !== ref) return 0;
  const rows = await db
    .update(secretFindings)
    .set({ status: "resolved" })
    .where(
      and(
        eq(secretFindings.organizationId, organizationId),
        eq(secretFindings.projectId, projectId),
        eq(secretFindings.status, "open"),
        eq(secretFindings.ref, ref),
        seen.length > 0 ? notInArray(secretFindings.fingerprint, [...seen]) : undefined,
      ),
    )
    .returning({ id: secretFindings.id });
  return rows.length;
}

export async function getFinding(
  db: Executor,
  organizationId: string,
  projectId: string,
  id: string,
) {
  return (
    await db
      .select()
      .from(secretFindings)
      .where(
        and(
          eq(secretFindings.id, id),
          eq(secretFindings.organizationId, organizationId),
          eq(secretFindings.projectId, projectId),
        ),
      )
  )[0];
}

/** A project's findings in creation order (v7 ids), optionally one status. Nothing here is a secret. */
export function listFindings(
  db: Executor,
  organizationId: string,
  projectId: string,
  page: Page<string>,
  opts: { status?: FindingStatus } = {},
) {
  return db
    .select()
    .from(secretFindings)
    .where(
      and(
        eq(secretFindings.organizationId, organizationId),
        eq(secretFindings.projectId, projectId),
        opts.status ? eq(secretFindings.status, opts.status) : undefined,
        page.after ? gt(secretFindings.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(secretFindings.id))
    .limit(page.limit);
}

export interface FindingScope {
  organizationId: string;
  projectId: string;
  id: string;
}
/** `unchanged` says what the finding is instead; nothing at all means no such finding in that project. */
export type FindingChange =
  | { result: "changed"; finding: SecretFinding }
  | { result: "unchanged"; status: FindingStatus }
  | undefined;

/** Moves a finding out of `from`, under a row lock so two people deciding at once see one outcome. */
async function moveFinding(
  tx: Executor,
  scope: FindingScope,
  from: FindingStatus,
  set: PgUpdateSetSource<typeof secretFindings>,
): Promise<FindingChange> {
  const where = and(
    eq(secretFindings.id, scope.id),
    eq(secretFindings.organizationId, scope.organizationId),
    eq(secretFindings.projectId, scope.projectId),
  );
  const [row] = await tx
    .select({ status: secretFindings.status })
    .from(secretFindings)
    .where(where)
    .for("update");
  if (!row) return undefined;
  if (row.status !== from) return { result: "unchanged", status: row.status as FindingStatus };
  const [finding] = await tx.update(secretFindings).set(set).where(where).returning();
  if (!finding) throw new Error("finding vanished while locked");
  return { result: "changed", finding };
}

/**
 * A person's call that a finding is not a live secret (a test key, an example). Only an open finding is
 * dismissed: a resolved one is gone already, and a second dismissal must not replace the first one's
 * reason and person. The scans that follow leave a dismissal alone.
 */
export const dismissFinding = (tx: Executor, scope: FindingScope, by: string, reason: string) =>
  moveFinding(tx, scope, "open", {
    status: "dismissed",
    dismissedBy: by,
    dismissedReason: reason,
    dismissedAt: sql`now()`,
  });

/** Takes a dismissal back: the finding is open again, with no trace of who dismissed it. */
export const reopenFinding = (tx: Executor, scope: FindingScope) =>
  moveFinding(tx, scope, "dismissed", {
    status: "open",
    dismissedBy: null,
    dismissedReason: null,
    dismissedAt: null,
  });

/** What an organization does about open secret findings (SCAN-6); undefined when there is no such organization. */
export async function getSecretGate(
  db: Executor,
  organizationId: string,
): Promise<SecretGate | undefined> {
  const [row] = await db
    .select({ gate: organizations.secretGate })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return row?.gate as SecretGate | undefined;
}

/** The previous setting, or undefined when there is no such organization. The table refuses anything but off, warn or deny. */
export async function setSecretGate(
  db: Executor,
  organizationId: string,
  gate: SecretGate,
): Promise<{ previous: SecretGate } | undefined> {
  const [before] = await db
    .select({ gate: organizations.secretGate })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("update");
  if (!before) return undefined;
  await db
    .update(organizations)
    .set({ secretGate: gate })
    .where(eq(organizations.id, organizationId));
  return { previous: before.gate as SecretGate };
}

/** Findings that are open and were seen on the project's default branch: the ones the gate judges. */
export async function countOpenFindings(
  db: Executor,
  scope: { organizationId: string; projectId: string },
): Promise<number> {
  const [row] = await db
    .select({ open: count() })
    .from(secretFindings)
    .innerJoin(projects, eq(projects.id, secretFindings.projectId))
    .where(
      and(
        eq(secretFindings.organizationId, scope.organizationId),
        eq(secretFindings.projectId, scope.projectId),
        eq(secretFindings.status, "open"),
        eq(secretFindings.ref, projects.defaultBranch),
      ),
    );
  return row?.open ?? 0;
}
