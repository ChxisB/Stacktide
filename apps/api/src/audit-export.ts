import type { AuditRow } from "@orch/db";

const COLUMNS = [
  "id",
  "at",
  "actor_kind",
  "actor_id",
  "action",
  "resource_type",
  "resource_id",
  "organization_id",
  "project_id",
  "request_id",
  "ip",
  "metadata",
] as const;

/**
 * One cell. A spreadsheet runs a cell that starts with `=`, `+`, `-`, `@`, a tab or a return as a
 * formula, and an actor id or a request id is text somebody else chose: it is made inert with a
 * leading `'`, then quoted if it holds a separator, a quote or a line break.
 */
export function csvCell(value: string | null): string {
  if (value === null) return "";
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** What an export row says: the same fields as the API's, the metadata as one JSON cell. */
export const auditFields = (r: AuditRow) => ({
  id: r.id,
  at: r.at.toISOString(),
  actorKind: r.actorKind,
  actorId: r.actorId,
  action: r.action,
  resourceType: r.resourceType,
  resourceId: r.resourceId,
  organizationId: r.organizationId,
  projectId: r.projectId,
  requestId: r.requestId,
  ip: r.ip,
  metadata: r.metadata,
});

export function auditCsv(rows: AuditRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const r of rows) {
    const f = auditFields(r);
    lines.push(
      [
        f.id,
        f.at,
        f.actorKind,
        f.actorId,
        f.action,
        f.resourceType,
        f.resourceId,
        f.organizationId,
        f.projectId,
        f.requestId,
        f.ip,
        JSON.stringify(f.metadata),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}
