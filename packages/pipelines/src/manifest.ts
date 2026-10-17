import { KEY_PATTERN, PROJECT_TAGS } from "@orch/core";
import { z } from "zod";

/** The JSON-schema types a template parameter may have: scalars only, so a value is always an inert string, number or flag. */
const paramSchema = z.strictObject({
  type: z.enum(["string", "number", "integer", "boolean"]),
  description: z.string().min(1).max(500).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  enum: z
    .array(z.union([z.string(), z.number()]))
    .min(1)
    .optional(),
  pattern: z.string().min(1).optional(),
  maxLength: z.int().positive().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
});

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** `manifest.json` of a template (PIPE-1): what it is, what it takes, what it fits, what it needs. */
export const manifestSchema = z
  .strictObject({
    name: z.string().regex(NAME),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    description: z.string().min(1).max(500),
    /** A JSON schema (a restricted subset) of the `params` a project may give. */
    params: z
      .strictObject({
        type: z.literal("object"),
        properties: z.record(z.string().regex(PARAM_NAME), paramSchema),
        required: z.array(z.string()).default([]),
      })
      .default({ type: "object", properties: {}, required: [] }),
    /** Project types (GL-7 tags) this template suits. */
    detects: z.array(z.enum(PROJECT_TAGS)).default([]),
    /** Variables the pipeline reads, by key; PIPE-5 reports the ones the platform lacks. */
    requiresVariables: z.array(z.string().regex(KEY_PATTERN)).default([]),
  })
  .superRefine((m, ctx) => {
    const { properties, required } = m.params;
    const bad = (path: string[], message: string) =>
      ctx.addIssue({ code: "custom", path: ["params", ...path], message });
    for (const name of required) {
      if (!Object.hasOwn(properties, name))
        bad(["required"], `"${name}" is required but not declared`);
      else if (properties[name]?.default !== undefined)
        bad(["required"], `"${name}" is required and has a default`);
    }
    for (const [name, p] of Object.entries(properties)) {
      const at = ["properties", name];
      const number = p.type === "number" || p.type === "integer";
      let sound = true;
      const refuse = (key: string, message: string) => {
        sound = false;
        bad([...at, key], message);
      };
      if (p.pattern !== undefined) {
        if (p.type !== "string") refuse("pattern", "only a string can have a pattern");
        else {
          try {
            new RegExp(p.pattern);
          } catch {
            refuse("pattern", "is not a regular expression");
          }
        }
      }
      if (p.maxLength !== undefined && p.type !== "string")
        refuse("maxLength", "only a string has a length");
      // a string ends up in a script: its template says what shape it may have, there is no free text by default
      if (p.type === "string" && p.pattern === undefined && p.enum === undefined)
        refuse("pattern", "a string needs an enum or a pattern: it ends up in a script");
      if ((p.minimum !== undefined || p.maximum !== undefined) && !number) {
        refuse("minimum", "only a number has a range");
      } else if ((p.minimum ?? -Infinity) > (p.maximum ?? Infinity)) {
        refuse("minimum", "is above the maximum");
      }
      if (!sound) continue;
      // every value the manifest offers must be one it accepts, or no project could ever pass
      const { enum: choices, ...rest } = p;
      for (const value of choices ?? []) {
        if (!z.fromJSONSchema(rest).safeParse(value).success)
          refuse("enum", `${JSON.stringify(value)} does not satisfy its own schema`);
      }
      if (p.default !== undefined && !z.fromJSONSchema(p).safeParse(p.default).success) {
        refuse("default", "does not satisfy its own schema");
      }
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;

/** Longest value a string parameter takes unless its manifest says otherwise. */
export const DEFAULT_MAX_LENGTH = 1000;

/** What a project's `params` must satisfy, defaults filled in; keys the manifest does not declare are refused. */
export const paramsSchema = (m: Manifest) => {
  const properties = Object.fromEntries(
    Object.entries(m.params.properties).map(([name, p]) => [
      name,
      p.type === "string" ? { maxLength: DEFAULT_MAX_LENGTH, ...p } : p,
    ]),
  );
  return z.fromJSONSchema({ ...m.params, properties, additionalProperties: false }) as z.ZodType<
    Record<string, unknown>
  >;
};
