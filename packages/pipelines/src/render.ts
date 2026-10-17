import { isDeepStrictEqual } from "node:util";
import { APP_NAME } from "@orch/core";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { Template } from "./loader";
import { paramsSchema } from "./manifest";
import { isMap, PLACEHOLDER, parsePipeline, type Tree } from "./pipeline";

/** Why a pipeline could not be rendered, one line each. They name parameters, never what was given. */
export class RenderError extends Error {
  constructor(readonly problems: string[]) {
    super(`cannot render:\n${problems.join("\n")}`);
  }
}

/**
 * One layer of configuration (lowest first: the organization's defaults, the project's, an
 * environment's). `params` fill the template's placeholders, a later layer's value winning;
 * `overrides` is a piece of pipeline merged over the template's: maps merge key by key, anything
 * else (a list too) is replaced. Placeholders are the template's alone: an override is literal.
 */
const layerSchema = z.strictObject({
  params: z.record(z.string(), z.unknown()).optional(),
  overrides: z.record(z.string(), z.json()).optional(),
});
export type Layer = z.input<typeof layerSchema>;

type Scalar = string | number | boolean;
const WHOLE = new RegExp(`^${PLACEHOLDER.source}$`);

/** Fills placeholders in string values only (keys and structure are never touched). */
function fill(node: unknown, params: Record<string, Scalar | undefined>, missing: Set<string>) {
  const value = (name: string) => {
    const v = params[name];
    if (v === undefined) missing.add(name);
    return v;
  };
  const walk = (n: unknown): unknown => {
    if (typeof n === "string") {
      const whole = WHOLE.exec(n);
      // a placeholder that is the whole value keeps its type (`retry: 2`); inside text it is text
      if (whole) return value(whole[1] ?? "");
      return n.replace(PLACEHOLDER, (_, name: string) => String(value(name)));
    }
    if (Array.isArray(n)) return n.map(walk);
    if (isMap(n)) return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]));
    return n;
  };
  return walk(node);
}

/** Maps merge, anything else on the right replaces what is on the left. Keys keep the left's order, new ones follow. */
function merge(left: unknown, right: unknown): unknown {
  if (!isMap(left) || !isMap(right)) return right;
  const keys = [...Object.keys(left), ...Object.keys(right).filter((k) => !Object.hasOwn(left, k))];
  return Object.fromEntries(
    keys.map((k) => [
      k,
      !Object.hasOwn(right, k)
        ? left[k]
        : Object.hasOwn(left, k)
          ? merge(left[k], right[k])
          : right[k],
    ]),
  );
}

/** Written as YAML 1.1 so that what GitLab's parser would read as a boolean, number or date is quoted. */
const WRITE = { version: "1.1", lineWidth: 0, indent: 2, aliasDuplicateObjects: false } as const;

/**
 * Renders a template to the text of a `.gitlab-ci.yml` (PIPE-3). Parameters are checked against the
 * manifest (defaults filled, unknown names refused), substituted into the template's parsed string
 * values (so a value can never become structure), the layers' overrides merged on top, and the result
 * written the same way every time. Before returning, the text is read back as YAML 1.1 and 1.2: if it
 * does not give the same document, it is refused rather than committed.
 */
export function render(template: Template, layers: Layer[] = []): string {
  const problems: string[] = [];
  let params: Record<string, unknown> = {};
  const clean: z.output<typeof layerSchema>[] = [];
  layers.forEach((layer, i) => {
    const parsed = layerSchema.safeParse(layer);
    if (!parsed.success) {
      for (const p of parsed.error.issues)
        problems.push(`layer ${i}: ${p.path.join(".") || "(root)"}: ${p.message}`);
      return;
    }
    // spread, not assign: a key called `__proto__` stays a key (and is refused as unknown), and a layer that says nothing (`undefined`) changes nothing
    params = {
      ...params,
      ...Object.fromEntries(
        Object.entries(parsed.data.params ?? {}).filter(([, v]) => v !== undefined),
      ),
    };
    clean.push(parsed.data);
  });
  const checked = paramsSchema(template.manifest).safeParse(params);
  if (!checked.success) {
    for (const p of checked.error.issues)
      problems.push(
        p.path.length > 0 ? `param ${p.path.join(".")}: ${p.message}` : `params: ${p.message}`,
      );
  }
  if (problems.length > 0 || !checked.success) throw new RenderError(problems);

  let tree: Tree;
  try {
    tree = parsePipeline(template.pipeline);
  } catch (e) {
    throw new RenderError([`pipeline.yml: ${e instanceof Error ? e.message : "cannot be read"}`]);
  }
  const missing = new Set<string>();
  let result = fill(tree, checked.data as Record<string, Scalar | undefined>, missing);
  if (missing.size > 0)
    throw new RenderError([...missing].map((n) => `param ${n}: has no value and no default`));
  for (const layer of clean) if (layer.overrides) result = merge(result, layer.overrides);

  const { name, version } = template.manifest;
  const text = `# Generated by ${APP_NAME} from template ${name}@${version}. Change the pipeline there: edits here are overwritten.\n${stringify(result, WRITE)}`;
  for (const v of ["1.1", "1.2"] as const) {
    if (!isDeepStrictEqual(parse(text, { version: v, merge: true }), result))
      throw new RenderError(["a value cannot be written so that every YAML reader sees the same"]);
  }
  return text;
}
