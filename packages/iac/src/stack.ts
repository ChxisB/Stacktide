import { parse } from "yaml";
import { z } from "zod";

export const TOOLS = ["terraform", "tofu", "terragrunt"] as const;
export const APPLY_ON = ["merge", "command"] as const;
export type Tool = (typeof TOOLS)[number];
export type ApplyOn = (typeof APPLY_ON)[number];

/** The file that marks a directory as a stack. */
export const MARKER = "stack.yml";
/** A manifest is a few lines; anything bigger is not one. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

// Names, tool versions and tags end up in job names, `resource_group`s, state names and image tags
// of generated pipelines, so they are closed character sets, not free text.
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,32})?$/;
const TAG = /^[a-z0-9][a-z0-9._-]{0,31}$/;

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

// A path in the repository, possibly a glob: relative, forward slashes, nothing that climbs out.
const watchPath = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !Array.from(p).some(isControl), {
    message: "must be a relative path with forward slashes",
  })
  .refine((p) => !p.split("/").includes(".."), { message: 'must not contain ".."' });

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
