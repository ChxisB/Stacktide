import { GitlabError } from "@orch/gitlab";
import type { z } from "zod";

/** Validates a GitHub payload; a mismatch names the field paths only, never the values. */
export function decode<S extends z.ZodType>(schema: S, data: unknown, what: string): z.output<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const paths = [...new Set(r.error.issues.map((i) => i.path.join(".") || "(root)"))].join(", ");
  throw new GitlabError("unexpected", `GitHub returned an unexpected ${what} (fields: ${paths})`);
}
