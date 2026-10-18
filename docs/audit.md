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
platform: that role can set the flag. Forward the log to a system it cannot write to if that matters to you (below).

## Forwarding it (GOV-4)

An organization admin can have the whole log handed to a collector as it grows. The collector is a **notification sink** of a
kind that takes it:

| Kind | `POST /organizations/:orgId/notification-sinks` body | What it gets |
|---|---|---|
| `webhook` | `{kind, name, url}` (the signing secret is returned once) | `POST {"events":[…]}`, signed like a notification: `x-orch-signature: v1=` HMAC-SHA256 of `${x-orch-timestamp}.${body}`, `x-orch-event: audit.events`, `x-orch-delivery: <sink id>:<last event id>` |
| `datadog` | `{kind, name, url, apiKey}` | the logs intake: an array of `{ddsource, ddtags, service, hostname, message}` (the `message` is the event as JSON) and the key in `DD-API-KEY` |
| `splunk` | `{kind, name, url, token}` | the HTTP event collector: one `{time, host, source, sourcetype, event}` object per line, `Authorization: Splunk <token>` |
| `syslog` | `{kind, name, url}` with `url` = `tls://host:port` (port 6514 if left out) | RFC 5424 messages over TLS in RFC 5425 frames (`<octets> <message>`, the length in bytes); the event is the JSON message |

The address and the credential are sealed with the sink and are never in an answer, a list, a log line, an audit row or a stored
error. The same address rules as for notifications apply (https, no credentials in the URL, a public host that still resolves to
public addresses on every delivery, redirects not followed); a syslog connection goes to an address that was checked (the first three the name has, in turn, until one answers). A
`slack` sink cannot take the audit log, and a `syslog`, `datadog` or `splunk` sink cannot take a project's notifications.

| Route | Action | Notes |
|---|---|---|
| `GET /organizations/:orgId/notification-sinks/:sinkId/audit-forwarding` | `audit.forwarding.read` | org admin; the cursor, the last delivery, the failures and the last error (a fixed sentence) |
| `PUT …/audit-forwarding` | `audit.forwarding.update` | org admin; `{from: "now" \| "start"}`, default `now`; 201 when it starts, 200 when it already ran (it keeps its place, `from` is ignored and not audited; `DELETE` first to start over) |
| `DELETE …/audit-forwarding` | `audit.forwarding.update` | org admin; stops it (the sink stays). Its place is forgotten: starting again from `now` skips what was written meanwhile, from `start` sends the log again |

**What is promised.** At least once, in the order of the event ids (`cursor` is the id of the last event handed over). The cursor
moves only after the collector has taken the batch (a 2xx, or the data written to the TLS connection), so a lost answer sends
the batch again: **a receiver must dedupe by event `id`**. Up to 100 events go in one request. A collector that fails is tried
again after 30 s, then twice as long each time, at most an hour, and its place is kept for as long as it takes; the log is not
held for it, though: retention can purge what it has not yet been sent. An event is handed over once its id is 30 s old, so an
event whose transaction committed a little after a newer one's still goes in order.

The worker runs it on the `audit.forward` schedule (`AUDIT_FORWARD_SECONDS`, default 30, `0` = off, otherwise at least 10) and,
because it opens sealed sinks, only where `ORCH_MASTER_KEYS` is set. Handing events over is not itself audited (that would feed
the log it forwards); starting and stopping are.

The events carry `ip` and the metadata (key names, never values). Treat the collector as part of the audit trail's trust base.
