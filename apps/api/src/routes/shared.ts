import { DomainError } from "@orch/core";
import { type Db, pgConstraint } from "@orch/db";
import { z } from "zod";
import type { PrincipalResolver } from "../principal";

export interface RouteDeps {
  db: Db;
  principal: PrincipalResolver;
}

export const notFound = (what: string) => new DomainError("not_found", 404, `${what} not found`);

/**
 * For `.catch()` after a transaction (a failed statement aborts it, so this cannot run inside):
 * turns a violated constraint we know by name into its API error, rethrows anything else.
 */
export const mapDbError = (known: Record<string, DomainError>) => (e: unknown) => {
  const name = pgConstraint(e);
  throw (name && known[name]) || e;
};

export const taken = (code: string, what: string) =>
  new DomainError(code, 409, `${what} is already in use`);

// ---- input schemas

export const name = z.string().trim().min(1).max(100);
/** Lower-case words joined by single dashes: safe in a URL and as an identifier. */
export const slug = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "lower-case letters and digits, separated by single dashes");
export const defaultBranch = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/, "not a valid branch name")
  .refine(
    (b) => !b.includes("..") && !b.endsWith("/") && !b.endsWith(".lock"),
    "not a valid branch name",
  );
/** A PATCH that names no field would change nothing: reject it instead of answering 200. */
export const nonEmpty = (o: object) => Object.keys(o).length > 0;
export const atLeastOne = "at least one field is required";

// ---- cursor pagination

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().max(300).optional(),
});

const invalidCursor = () => new DomainError("invalid_cursor", 400, "The cursor is not valid");

/** Opaque to clients: the sort key of the last row, so the next page continues after it. */
export const encodeCursor = (key: unknown[]) =>
  Buffer.from(JSON.stringify(key)).toString("base64url");

function decodeCursor<K>(cursor: string, schema: z.ZodType<K>): K {
  try {
    const parsed = schema.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    if (parsed.success) return parsed.data;
  } catch {}
  throw invalidCursor();
}

/**
 * One page of a keyset-ordered list. `fetch` gets one row more than `limit`, which tells whether a
 * next page exists. The cursor is not signed: it only ever narrows the caller's own query.
 */
export async function paged<Row, Key extends unknown[], Dto>(
  query: { limit: number; cursor?: string },
  spec: {
    key: z.ZodType<Key>;
    keyOf: (row: Row) => Key;
    fetch: (after: Key | undefined, limit: number) => Promise<Row[]>;
    dto: (row: Row) => Dto;
  },
) {
  const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor, spec.key);
  const rows = await spec.fetch(after, query.limit + 1);
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items: items.map(spec.dto),
    nextCursor: rows.length > query.limit && last ? encodeCursor(spec.keyOf(last)) : null,
  };
}

export const iso = (d: Date) => d.toISOString();

// ---- output schemas (they also feed the OpenAPI document and the typed client)

export const stamps = { createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };
export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/** What `problem()` in ../problem.ts sends. */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  request_id: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof problemSchema>;
// 400: unreadable body or bad cursor, 422: input that fails validation.
export const readErrors = { 400: problemSchema, 404: problemSchema, 422: problemSchema } as const;
export const writeErrors = { ...readErrors, 409: problemSchema, 415: problemSchema } as const;
/** Deletes: no body on success; they conflict (409), and 415 if a client sends a non-JSON body. */
export const deleteResponses = { 204: z.undefined(), ...writeErrors } as const;
