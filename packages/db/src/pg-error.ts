/** Postgres SQLSTATE (e.g. "23505" unique violation, "23503" foreign key) from a query error. */
export function pgCode(e: unknown): string | undefined {
  // Drizzle wraps the driver error in `cause`; the bound also stops cyclic chains.
  for (let cur = e, depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    const { code, errno } = cur as { code?: unknown; errno?: unknown };
    // `code` marks an error the server sent; socket errors (EPIPE, ...) also carry an errno.
    if (code === "ERR_POSTGRES_SERVER_ERROR" && typeof errno === "string") return errno;
    cur = (cur as { cause?: unknown }).cause;
  }
}
