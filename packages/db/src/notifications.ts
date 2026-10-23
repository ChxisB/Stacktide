import type { NotificationEvent, SinkKind } from "@orch/core";
import {
  aad,
  decrypt,
  encrypt,
  generateDek,
  type KeyProvider,
  unwrapDek,
  wrapDek,
} from "@orch/crypto";
import { and, asc, eq, gt, notInArray, or } from "drizzle-orm";
import { enqueue } from "./jobs";
import type { Executor, Page } from "./repo";
import { notificationSinks, notificationSubscriptions, projects } from "./schema";

/** The job that delivers one notification to one sink. */
export const NOTIFY_QUEUE = "notify.deliver";
// 1 s doubling is about 8.5 minutes over 10 attempts: long enough for a receiver's restart, short enough to be news.
const DELIVERY_ATTEMPTS = 10;

/**
 * Everything callers get to see of a sink: no address, no signing secret, no data key, no
 * ciphertext. A column added to the table must be listed here (the `Sink` type fails to compile
 * until it is).
 */
const visible = {
  id: notificationSinks.id,
  organizationId: notificationSinks.organizationId,
  kind: notificationSinks.kind,
  name: notificationSinks.name,
  host: notificationSinks.host,
  createdAt: notificationSinks.createdAt,
  updatedAt: notificationSinks.updatedAt,
};
export type Sink = Omit<
  typeof notificationSinks.$inferSelect,
  "secretEnc" | "dekKeyId" | "dekWrapped" | "kind"
> & { kind: SinkKind };

// What the secret and the data key are bound to: a ciphertext (or a wrapped key) moved to
// another row, or to another organization's row, does not open.
const secretAad = (organizationId: string, id: string) =>
  aad("notification_sink", organizationId, id);
const keyContext = (id: string) => `notification_sink:${id}`;

export { keyContext as sinkKeyContext }; // `rewrap.ts` needs the same context to move a key

const inOrg = (organizationId: string, id: string) =>
  and(eq(notificationSinks.id, id), eq(notificationSinks.organizationId, organizationId));

/**
 * Stores a sink. `secret` (what the delivery needs to reach it: the address, and a webhook's signing
 * secret) is sealed with a data key made for this sink, and that key is wrapped by the provider's
 * current master key: the plaintext is never written anywhere.
 */
export async function createSink(
  db: Executor,
  keys: KeyProvider,
  input: { organizationId: string; kind: SinkKind; name: string; host: string; secret: string },
): Promise<Sink> {
  const id = Bun.randomUUIDv7(); // the ids are part of what the ciphertext is bound to
  const dek = generateDek();
  const wrap = await wrapDek(keys, dek, keyContext(id));
  const [row] = await db
    .insert(notificationSinks)
    .values({
      id,
      organizationId: input.organizationId,
      kind: input.kind,
      name: input.name,
      host: input.host,
      secretEnc: encrypt(dek, input.secret, secretAad(input.organizationId, id)),
      dekKeyId: wrap.keyId,
      dekWrapped: wrap.wrapped,
    })
    .returning(visible);
  if (!row) throw new Error("insert returned no row");
  return row as Sink;
}

export async function getSink(db: Executor, organizationId: string, id: string) {
  return (await db.select(visible).from(notificationSinks).where(inOrg(organizationId, id)))[0] as
    | Sink
    | undefined;
}

/** Ordered by id (a v7 uuid: creation order to the millisecond, not a strict guarantee). */
export function listSinks(db: Executor, organizationId: string, page: Page<string>) {
  return db
    .select(visible)
    .from(notificationSinks)
    .where(
      and(
        eq(notificationSinks.organizationId, organizationId),
        page.after ? gt(notificationSinks.id, page.after) : undefined,
      ),
    )
    .orderBy(asc(notificationSinks.id))
    .limit(page.limit) as Promise<Sink[]>;
}

/** True when a row was deleted; its subscriptions go with it. */
export async function deleteSink(db: Executor, organizationId: string, id: string) {
  const rows = await db
    .delete(notificationSinks)
    .where(inOrg(organizationId, id))
    .returning({ id: notificationSinks.id });
  return rows.length > 0;
}

/**
 * The one way to get a sink's secret back, for the code that delivers to it. The plaintext must go
 * nowhere else: not a log, an error, an audit row or a response. Throws a `CryptoError` when the
 * master key is gone or the row was tampered with.
 */
export async function openSink(
  db: Executor,
  keys: KeyProvider,
  organizationId: string,
  id: string,
): Promise<{ sink: Sink; secret: string } | undefined> {
  const [row] = await db
    .select({
      ...visible,
      secretEnc: notificationSinks.secretEnc,
      dekKeyId: notificationSinks.dekKeyId,
      dekWrapped: notificationSinks.dekWrapped,
    })
    .from(notificationSinks)
    .where(inOrg(organizationId, id));
  if (!row) return undefined;
  const dek = await unwrapDek(
    keys,
    { keyId: row.dekKeyId, wrapped: row.dekWrapped },
    keyContext(row.id),
  );
  const { secretEnc, dekKeyId: _k, dekWrapped: _w, ...sink } = row;
  return {
    sink: sink as Sink,
    secret: decrypt(dek, secretEnc, secretAad(row.organizationId, row.id)),
  };
}

/**
 * Makes `events` exactly what the project asks of the sink. Run it in a transaction. It removes what
 * is no longer asked and adds the rest without failing on what is there, so two of these at once
 * (an admin retrying) end the same way instead of one hitting the primary key.
 */
export async function setSubscriptions(
  db: Executor,
  s: {
    organizationId: string;
    projectId: string;
    sinkId: string;
    events: readonly NotificationEvent[];
  },
): Promise<void> {
  const events = [...new Set(s.events)];
  await db
    .delete(notificationSubscriptions)
    .where(
      and(
        eq(notificationSubscriptions.sinkId, s.sinkId),
        eq(notificationSubscriptions.projectId, s.projectId),
        eq(notificationSubscriptions.organizationId, s.organizationId),
        events.length === 0 ? undefined : notInArray(notificationSubscriptions.event, events),
      ),
    );
  if (events.length === 0) return;
  await db
    .insert(notificationSubscriptions)
    .values(
      events.map((event) => ({
        organizationId: s.organizationId,
        projectId: s.projectId,
        sinkId: s.sinkId,
        event,
      })),
    )
    .onConflictDoNothing();
}

/** True when the project asked anything of the sink. */
export async function removeSubscriptions(
  db: Executor,
  organizationId: string,
  projectId: string,
  sinkId: string,
) {
  const rows = await db
    .delete(notificationSubscriptions)
    .where(
      and(
        eq(notificationSubscriptions.sinkId, sinkId),
        eq(notificationSubscriptions.projectId, projectId),
        eq(notificationSubscriptions.organizationId, organizationId),
      ),
    )
    .returning({ sinkId: notificationSubscriptions.sinkId });
  return rows.length > 0;
}

/** What a project asks of which sinks, ordered by sink id and event. */
export function listSubscriptions(
  db: Executor,
  organizationId: string,
  projectId: string,
  page: Page<[string, string]>,
) {
  const [afterSink, afterEvent] = page.after ?? [];
  return db
    .select({
      sinkId: notificationSubscriptions.sinkId,
      event: notificationSubscriptions.event,
      name: notificationSinks.name,
      kind: notificationSinks.kind,
      host: notificationSinks.host,
    })
    .from(notificationSubscriptions)
    .innerJoin(
      notificationSinks,
      and(
        eq(notificationSinks.id, notificationSubscriptions.sinkId),
        eq(notificationSinks.organizationId, notificationSubscriptions.organizationId),
      ),
    )
    .where(
      and(
        eq(notificationSubscriptions.projectId, projectId),
        eq(notificationSubscriptions.organizationId, organizationId),
        afterSink === undefined || afterEvent === undefined
          ? undefined
          : or(
              gt(notificationSubscriptions.sinkId, afterSink),
              and(
                eq(notificationSubscriptions.sinkId, afterSink),
                gt(notificationSubscriptions.event, afterEvent),
              ),
            ),
      ),
    )
    .orderBy(asc(notificationSubscriptions.sinkId), asc(notificationSubscriptions.event))
    .limit(page.limit) as Promise<
    { sinkId: string; event: NotificationEvent; name: string; kind: SinkKind; host: string }[]
  >;
}

/**
 * Queues one delivery of `event` for each sink the project asked to hear of it, in the transaction of
 * the change that is the news, so a delivery exists exactly when the change does. A delivery carries
 * ids, names and counts (the sink's address is read when it runs). Returns how many were queued.
 */
async function fanOut(
  tx: Executor,
  at: { organizationId: string; projectId: string; event: NotificationEvent; when: Date },
  facts: Record<string, string | number | null>,
): Promise<number> {
  const [project] = await tx
    .select({ name: projects.name })
    .from(projects)
    .where(and(eq(projects.id, at.projectId), eq(projects.organizationId, at.organizationId)));
  if (!project) return 0;
  const subscribed = await tx
    .select({ sinkId: notificationSubscriptions.sinkId })
    .from(notificationSubscriptions)
    .where(
      and(
        eq(notificationSubscriptions.projectId, at.projectId),
        eq(notificationSubscriptions.organizationId, at.organizationId),
        eq(notificationSubscriptions.event, at.event),
      ),
    )
    .orderBy(asc(notificationSubscriptions.sinkId));
  for (const { sinkId } of subscribed) {
    await enqueue(tx, {
      queue: NOTIFY_QUEUE,
      maxAttempts: DELIVERY_ATTEMPTS,
      payload: {
        sinkId,
        organizationId: at.organizationId,
        event: at.event,
        projectId: at.projectId,
        projectName: project.name,
        ...facts,
        at: at.when.toISOString(),
      },
    });
  }
  return subscribed.length;
}

/** `stack.drift`: a stack drifted from its code or came back in line. */
export function notifyStackDrift(
  tx: Executor,
  n: {
    organizationId: string;
    projectId: string;
    stack: string;
    status: "drifted" | "clean";
    add: number;
    change: number;
    destroy: number;
    at: Date;
  },
): Promise<number> {
  const { at, organizationId, projectId, ...facts } = n;
  return fanOut(tx, { organizationId, projectId, event: "stack.drift", when: at }, facts);
}

/** `rotation.failing`: a variable's rotation has failed `attempts` times in a row. Only the key's name, never a value. */
export function notifyRotationFailing(
  tx: Executor,
  n: {
    organizationId: string;
    projectId: string;
    key: string;
    provider: string;
    attempts: number;
    at: Date;
  },
): Promise<number> {
  const { at, organizationId, projectId, ...facts } = n;
  return fanOut(tx, { organizationId, projectId, event: "rotation.failing", when: at }, facts);
}

/** `deployment.failed`: a deployment to an environment failed. The environment's slug, eight characters of the commit and GitLab's pipeline address: no message, no author. */
export function notifyDeploymentFailed(
  tx: Executor,
  n: {
    organizationId: string;
    projectId: string;
    environment: string;
    sha: string;
    pipelineUrl: string | null;
    at: Date;
  },
): Promise<number> {
  const { at, organizationId, projectId, sha, ...facts } = n;
  return fanOut(
    tx,
    { organizationId, projectId, event: "deployment.failed", when: at },
    { ...facts, sha: sha.slice(0, 8) },
  );
}
