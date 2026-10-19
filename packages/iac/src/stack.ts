import { parse } from "yaml";
import { z } from "zod";

export const TOOLS = ["terraform", "tofu", "terragrunt"] as const;
export const APPLY_ON = ["merge", "command"] as const;
/** Where a stack's Terraform state lives: GitLab's managed state (D9), or the platform's own (ADR-0017). */
export const STATE_STORES = ["gitlab", "orch"] as const;
export type Tool = (typeof TOOLS)[number];
export type ApplyOn = (typeof APPLY_ON)[number];
export type StateStore = (typeof STATE_STORES)[number];

/** The file that marks a directory as a stack. */
export const MARKER = "stack.yml";
/** A manifest is a few lines; anything bigger is not one. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

// Names, tool versions and tags end up in job names, `resource_group`s, state names and image tags
// of generated pipelines, so they are closed character sets, not free text.
export const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
export const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,32})?$/;
export const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;
// The platform's own rule for an environment's slug (apps/api routes/shared.ts), so that a marker
// cannot name one that could never exist. It ends up in a generated job's `environment:`.
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const name = z
  .string()
  .regex(
    NAME,
    "must be 1-63 lowercase letters, digits or hyphens, not starting or ending with one",
  );

const isControl = (c: string) => {
  const n = c.charCodeAt(0);
  return n < 0x20 || n === 0x7f;
};

// An opener with no closer, or an empty class, is not an error to a glob matcher: the pattern just
// never matches, and a stack whose shared module is watched through it would silently never be planned.
const closed = (p: string) => {
  let braces = 0;
  let inClass = false;
  let size = 0; // characters in the class so far; a leading ! or ^ negates and is not one
  for (const c of p) {
    if (inClass) {
      if (c === "]") {
        if (size === 0) return false; // an empty class matches nothing
        inClass = false;
      } else if (size > 0 || (c !== "!" && c !== "^")) size++;
    } else if (c === "[") {
      inClass = true;
      size = 0;
    } else if (c === "{") braces++;
    else if (c === "}" && braces > 0) braces--;
  }
  return !inClass && braces === 0;
};

// A path in the repository, possibly a glob: relative to the repository root, forward slashes,
// nothing that climbs out. Whatever could never match is refused here, because a watch that matches
// nothing fails silently: a leading `./`, a trailing `/`, an empty segment, a leading `!`.
const watchPath = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.startsWith("!") &&
      !p.includes("\\") &&
      !Array.from(p).some(isControl),
    { message: "must be a relative path with forward slashes, not starting with !" },
  )
  .refine((p) => p.split("/").every((s) => s !== "" && s !== "." && s !== ".."), {
    message: 'must not have empty, "." or ".." segments (no leading ./ or trailing /)',
  })
  .refine(closed, { message: "has an empty or unclosed [ class, or a { that is never closed" });

/**
 * What `stack.yml` says. Strict: a misspelt key (`depend_on`) must be an error, not a stack that
 * silently has no dependencies. Nothing is applied unless the file asks for it, so `apply_on`
 * defaults to the explicit command.
 */
export const stackManifest = z.strictObject({
  name,
  tool: z.enum(TOOLS),
  version: z.string().regex(VERSION, "must look like 1.9.8 (no v, no range)").optional(),
  tags: z
    .array(z.string().regex(TAG, "must be lowercase letters, digits, . _ -"))
    .max(20)
    .default([]),
  depends_on: z.array(name).max(50).default([]),
  watch: z.array(watchPath).max(50).default([]),
  apply_on: z.enum(APPLY_ON).default("command"),
  // the platform environment whose variables the stack's plan gets as `TF_VAR_*` (IAC-11)
  environment: z
    .string()
    .max(63)
    .regex(SLUG, "must be the slug of an environment: lowercase letters and digits, single dashes")
    .optional(),
  // the organization's worker pool whose runner tags the stack's jobs ask for (POOL-2); none: the default pool, if there is one
  pool: z
    .string()
    .max(63)
    .regex(SLUG, "must be the name of a worker pool: lowercase letters and digits, single dashes")
    .optional(),
  // where the stack's state lives (STATE-5); none: GitLab's, as it always was
  state: z.enum(STATE_STORES).optional(),
  // how often the platform plans the stack to see whether the real infrastructure still matches (POL-1)
  drift_every: z
    .string()
    .regex(/^[1-9]\d{0,2}[hd]$/, "must be whole hours or days, like 6h or 1d")
    .transform((v) => Number.parseInt(v, 10) * (v.endsWith("d") ? 86_400 : 3_600))
    .optional(),
});
export type StackManifest = z.output<typeof stackManifest>;

export type Parsed = { ok: true; manifest: StackManifest } | { ok: false; errors: string[] };

/** Reads the text of a `stack.yml`; says what is wrong in words, never throws. */
export function parseManifest(text: string): Parsed {
  let doc: unknown;
  try {
    // no aliases: a small file must not expand into a large one
    doc = parse(text, { maxAliasCount: 0 });
  } catch (e) {
    const message = e instanceof Error ? e.message.split("\n")[0] : undefined;
    return { ok: false, errors: [`not valid YAML: ${message ?? "unreadable"}`] };
  }
  const result = stackManifest.safeParse(doc ?? undefined);
  if (result.success) return { ok: true, manifest: result.data };
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, errors: ["must be a mapping of keys to values"] };
  }
  return {
    ok: false,
    errors: result.error.issues.map((i) =>
      i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message,
    ),
  };
}
