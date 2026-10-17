interface ServerError {
  errno: string;
  constraint?: unknown;
}

/** The error the Postgres server sent, found on `e` or anywhere down its cause chain. */
function serverError(e: unknown): ServerError | undefined {
  // Drizzle wraps the driver error in `cause`; the bound also stops cyclic chains.
  for (let cur = e, depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    const { code, errno } = cur as { code?: unknown; errno?: unknown };
    // `code` marks an error the server sent; socket errors (EPIPE, ...) also carry an errno.
    if (code === "ERR_POSTGRES_SERVER_ERROR" && typeof errno === "string") {
      return cur as ServerError;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
}

/** Postgres SQLSTATE (e.g. "23505" unique violation, "23503" foreign key) from a query error. */
export const pgCode = (e: unknown): string | undefined => serverError(e)?.errno;

/** Name of the violated constraint (our names are explicit and stable), if the server gave one. */
export function pgConstraint(e: unknown): string | undefined {
  const name = serverError(e)?.constraint;
  return typeof name === "string" ? name : undefined;
}
