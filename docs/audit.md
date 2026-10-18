# The audit log

Every change the platform makes writes an event in the same transaction as the change (API-8). An event holds who
(`actor_kind`, `actor_id`), what (`action`, `resource_type`, `resource_id`), where (organization and project ids), when,
the request id and the caller's IP, and a small `metadata` of ids, key names and counts. A value never goes in: the write
refuses a key that looks like one, and a string over 256 characters. The table is append-only; a trigger rejects UPDATE,
DELETE and TRUNCATE, except for the purge below.

## Reading it (GOV-1)

All of these are per organization and need an org **admin** (an API token needs the action by name, and `organization.read`).

| Call | Action | |
|---|---|---|
| `GET /organizations/:orgId/audit-events` | `audit.read` | newest first, cursor-paged (`limit`, `cursor` → `nextCursor`) |
| `GET /organizations/:orgId/audit-events/export` | `audit.export` | `format=json\|csv`, up to 5000 rows, `x-next-cursor` for the rest; **itself audited** (`audit.export`: the filters, the format, the row count) |
| `GET /organizations/:orgId/audit-retention` | `audit.retention.read` | `{ "days": 90 }` or `{ "days": null }` (kept for ever) |
| `PUT /organizations/:orgId/audit-retention` | `audit.retention.update` | **org owner only**; `days` 30 to 3650, or `null` |

Filters (list and export): `action` (exact, or a prefix `variable.*`), `actorKind`, `actorId`, `resourceType`, `resourceId`,
`projectId`, `since` (inclusive) and `until` (exclusive), both ISO times. Events that name no organization (a sign-in, for
instance) are not in any organization's log.

A CSV cell that a spreadsheet would run as a formula (it starts with `=`, `+`, `-`, `@`, a tab or a return) is written with a
leading `'`. The metadata is one JSON cell.

## Retention and the purge

An organization keeps its events for ever until an owner sets a retention. The worker's `audit.purge` schedule
(`AUDIT_PURGE_SECONDS`, default 3600, `0` = off) calls the SQL function `audit_purge_expired(batch)`, which deletes at most
`batch` events older than **their own organization's** retention, oldest first, and writes an `audit.purge` event (the count)
per organization it took from, in the same transaction. The function takes no cutoff; events of an organization with no
retention, of one that no longer exists, and events with no organization are never deleted. The function turns on a
transaction-local flag that the trigger honours for DELETE only, and turns it off before it returns.

Treat the log as append-only against the platform's own bugs, not against whoever holds the database credentials of the
platform: that role can set the flag. Forward the log to a system it cannot write to if that matters to you (GOV-4).
