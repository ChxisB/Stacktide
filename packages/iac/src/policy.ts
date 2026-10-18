import { safeDir } from "./scan";
import { TAG } from "./stack";

/**
 * A policy set (POL-3): a directory of Rego policies in a repository of the same GitLab, and the
 * stack tag it is attached to. A stack that carries the tag has its plan judged by the set.
 */
export interface PolicySet {
  name: string;
  /** The GitLab project that holds the policies, as `group/project`. */
  source: string;
  /** A branch, tag or commit of it. A commit or protected tag cannot move under the plans it judged. */
  ref: string;
  /** The directory of the policies in it; `.` is the root. */
  path: string;
  tag: string;
}

// Everything below ends up in a URL and a shell command of the generated job: closed character sets.
export const POLICY_SOURCE =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}){1,19}$/;
export const POLICY_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
export const POLICY_TAG = TAG;

/** What is wrong with a set, in words; nothing when it can be used in a job. */
export function policySetProblems(s: PolicySet): string[] {
  const out: string[] = [];
  if (!POLICY_SOURCE.test(s.source)) out.push("source is not a GitLab project path");
  if (!POLICY_REF.test(s.ref) || s.ref.includes("..")) out.push("ref is not usable");
  if (!safeDir(s.path)) out.push("path is not a usable directory");
  if (!POLICY_TAG.test(s.tag)) out.push("tag is not a usable stack tag");
  return out;
}

/** The sets a stack with these tags is judged by. */
export const setsFor = (tags: readonly string[], sets: readonly PolicySet[]) =>
  sets.filter((s) => tags.includes(s.tag));

/**
 * Reduces what `conftest test --output json` printed (one result per file and namespace, each with
 * `failures` and `warnings`) to the names of the rules that fired, never their messages: a message
 * may quote the plan, and a plan holds secrets. Run with `jq -e -c -s`: an answer that is not a
 * list of at least one result (empty, an error, nothing at all) is an error, never an empty verdict:
 * nothing judged is not a pass.
 */
export const POLICY_FILTER = [
  '.[0] | if type == "array" and length > 0 then',
  "{stack: $stack, evaluated: true,",
  'denied: ([.[].failures[]? | (.metadata.query // "unnamed") | tostring | gsub("[^A-Za-z0-9_.:-]"; "_") | .[:200]] | unique | .[:50]),',
  'warned: ([.[].warnings[]? | (.metadata.query // "unnamed") | tostring | gsub("[^A-Za-z0-9_.:-]"; "_") | .[:200]] | unique | .[:50])}',
  'else error("not a policy result") end',
].join(" ");
