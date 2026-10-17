import { isCollection, parseDocument, visit } from "yaml";
import { z } from "zod";
import type { Manifest } from "./manifest";

/** A parsed pipeline: a YAML mapping read into plain JSON values. */
export type Tree = Record<string, unknown>;

/** `{{ params.name }}`: the only placeholder there is. */
export const PLACEHOLDER = /\{\{\s*params\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
/** Anything that tries to be one, so that a typo is an error and not text. */
const LOOKS_LIKE_ONE = /\{\{\s*params\b/;

export const isMap = (v: unknown): v is Tree =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Reads a template's `pipeline.yml` as strictly as it can be read: one document, unique keys, no
 * tags (GitLab's `!reference` included: it would be lost), no aliases that loop, only JSON values.
 * Throws an `Error` whose message says what is wrong, in one line.
 */
export function parsePipeline(text: string): Tree {
  const doc = parseDocument(text, { merge: true });
  const [problem] = [...doc.errors, ...doc.warnings];
  if (problem) throw new Error(problem.message.split("\n")[0]?.replace(/:$/, ""));
  let keyed = false;
  visit(doc, {
    Pair: (_, pair) => {
      if (isCollection(pair.key)) keyed = true;
    },
  });
  if (keyed) throw new Error("a map or a list is used as a key: is a placeholder not quoted?");
  let tree: unknown;
  try {
    tree = doc.toJS();
    JSON.stringify(tree); // throws on an alias that refers to itself
  } catch {
    throw new Error("the aliases cannot be expanded");
  }
  if (!isMap(tree)) throw new Error("the pipeline is not a mapping");
  if (!z.json().safeParse(tree).success) throw new Error("holds a value that is not JSON");
  return tree;
}

/** Every parameter a tree mentions, and each place a placeholder is wrong. */
function usage(tree: unknown, path: string, used: Set<string>, problems: string[]) {
  if (typeof tree === "string") {
    for (const m of tree.matchAll(PLACEHOLDER)) used.add(m[1] ?? "");
    if (LOOKS_LIKE_ONE.test(tree.replace(PLACEHOLDER, "")))
      problems.push(`${path}: a placeholder is written {{ params.name }}`);
  } else if (Array.isArray(tree)) {
    tree.forEach((v, i) => {
      usage(v, `${path}[${i}]`, used, problems);
    });
  } else if (isMap(tree)) {
    for (const [k, v] of Object.entries(tree)) {
      const at = path ? `${path}.${k}` : k;
      if (LOOKS_LIKE_ONE.test(k)) problems.push(`${at}: a placeholder cannot be in a key`);
      usage(v, at, used, problems);
    }
  }
}

/**
 * What is wrong with a template's pipeline, one line each (none: it is sound): not YAML the
 * renderer can read, a placeholder that is malformed or in a key, a parameter used and not declared,
 * and one declared and never used (a typo on either side).
 */
export function checkPipeline(manifest: Manifest, text: string): string[] {
  let tree: Tree;
  try {
    tree = parsePipeline(text);
  } catch (e) {
    return [e instanceof Error ? e.message : "cannot be read"];
  }
  const used = new Set<string>();
  const problems: string[] = [];
  usage(tree, "", used, problems);
  const declared = Object.keys(manifest.params.properties);
  for (const name of used)
    if (!Object.hasOwn(manifest.params.properties, name))
      problems.push(`parameter ${name} is used but not declared in the manifest`);
  for (const name of declared)
    if (!used.has(name)) problems.push(`parameter ${name} is declared but never used`);
  return problems;
}
