import { stringify } from "yaml";
import { buildGraph } from "./graph";
import { POLICY_FILTER, type PolicySet, policySetProblems, setsFor } from "./policy";
import { type PoolRef, resolvePool } from "./pool";
import { type Stack, safeDir } from "./scan";
import { NAME, SLUG, type Tool, VERSION } from "./stack";

/** Everything wrong with the request, so that it can be fixed in one go. */
export class GenerateError extends Error {
  constructor(readonly problems: string[]) {
    super(`cannot generate the pipeline: ${problems.join("; ")}`);
    this.name = "GenerateError";
  }
}

interface Common {
  /** Every stack of the repository: the graph is built from all of them, so a cycle anywhere is found. */
  stacks: readonly Stack[];
  /** The stacks to act on, by name. */
  select: readonly string[];
  /** Image repository (no tag) per tool; the stack's version is the tag. Terragrunt has no default. */
  images?: Partial<Record<Tool, string>>;
  /** Extra `id_tokens` for the tool jobs, name -> `aud`: how a job signs in to a cloud (OIDC). */
  cloudTokens?: Readonly<Record<string, string>>;
  /**
   * The organization's worker pools (POOL-3). A stack's jobs ask for the tags of the pool it names, else of
   * the default's; a stack that names a pool not in this list, or a disabled one, is an error and never
   * runs on shared runners. Leaving it out is "the organization has none": a stack that names one is refused.
   */
  pools?: readonly PoolRef[];
}

/** Where a job signs in to the platform: its address as runners reach it (no trailing slash) and the `aud` of its `id_token`. */
export interface Platform {
  apiUrl: string;
  audience: string;
}

export interface PlanInput extends Common {
  action: "plan";
  /** The `aud` of the platform's `id_token` (the API's `ORCH_CI_AUDIENCE`). */
  audience: string;
  /** The API's address, without a trailing slash. */
  apiUrl: string;
  /** Where the summary job posts, relative to `apiUrl`; the run it belongs to is part of it. */
  summaryPath: string;
  /** An image with `orch`, `curl` and `jq`, for the job that posts the summary. */
  helperImage: string;
  /**
   * Policy (POL-3): a stack that carries the tag of a set has its plan judged by it, in its summary
   * job, which then runs `image` (the helper's tools and `conftest`) and posts the verdict to `path`.
   * A stack the sets reach with no `image` is an error: it would be planned with nothing to judge it.
   */
  policy?: { sets: readonly PolicySet[]; image?: string | undefined; path: string };
  /**
   * Cost (COST-4): each selected stack in `stacks` is estimated by `image` (infracost and jq) in an
   * `estimate` job of its own, and its summary job posts the estimate with the counts. The job never
   * fails the pipeline and holds neither the platform's token nor the policy engine: with no estimate
   * the platform judges the plan as it has none (see `costVerdict` in core).
   */
  cost?: { stacks: readonly string[]; image: string };
}

export interface ApplyInput extends Common {
  action: "apply";
  /** The GitLab job that saved each stack's plan. */
  planJobs: Readonly<Record<string, number>>;
  /**
   * The platform an apply job of a stack with `state: orch` signs in to (STATE-5). A plan has it in its own input;
   * an apply needs it for that stack only, and without it the stack is refused.
   */
  platform?: Platform | undefined;
}

export type GenerateInput = PlanInput | ApplyInput;

const IMAGES: Partial<Record<Tool, string>> = {
  terraform: "hashicorp/terraform",
  tofu: "ghcr.io/opentofu/opentofu",
  // the stock image has no orch: a zone with an environment passes its own (see `images`)
  dnscontrol: "dnscontrol/dnscontrol",
};

// Docker's reference grammar, a little stricter: lowercase, a registry port only before a path.
const PART = "[a-z0-9]+(?:[._-][a-z0-9]+)*";
const REPO = `${PART}(?::\\d{1,5}(?=/))?(?:/${PART})*`;
const repository = new RegExp(`^${REPO}$`);
const image = new RegExp(
  `^${REPO}(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$`,
);
/** Whether `s` is an image reference the generator will write into a job (a pool's image is judged by this). */
export const isImageReference = (s: string) => image.test(s);
/** Whether `s` is an address the generator will write into a job: http(s)://host[:port][/path], no trailing slash. */
export const isApiUrl = (s: string) => API_URL.test(s);
// A runner tag as it is written into a job: the pool's own rule (`POOL_TAG` in core), so a space, comma or `$` is refused here too.
const RUNNER_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const API_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/;
const PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const AUDIENCE = /^[\x21-\x7e]{1,255}$/;

const EXPIRE_IN = "1 week";
/** How long a plan stays applicable: `EXPIRE_IN` in milliseconds. Its artifact is gone after that. */
export const PLAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// GitLab's limit on `needs` entries per job.
const MAX_NEEDS = 50;
// shortcut: the plan wait for the state lock is fixed; upgrade when a stack needs another one.
const LOCK_TIMEOUT = "5m";
// A job on the platform's state is cut off after this: the state token lives as long as `MAX_CI_TTL_MS` in the API (one hour).
const STATE_JOB_TIMEOUT = "1h";
// shortcut: at most 500 resources are listed in a summary (the counts are whole); the plan-summary route refuses more, so raise both together.
const MAX_LISTED = 500;

/**
 * The summary a plan job posts, from `terraform show -json`: counts the way terraform counts them (a
 * replacement is one to add and one to destroy) and the address and actions of each resource, never
 * a value: a plan holds secrets.
 */
export const SUMMARY_FILTER = [
  '(.resource_changes // []) | map(select(.change.actions != ["no-op"] and .change.actions != ["read"])) as $c',
  "| {stack: $stack,",
  'add: ($c | map(select(.change.actions | index("create"))) | length),',
  'change: ($c | map(select(.change.actions == ["update"])) | length),',
  'destroy: ($c | map(select(.change.actions | index("delete"))) | length),',
  `resources: ($c | map({address, actions: .change.actions}) | .[:${MAX_LISTED}])}`,
].join(" ");

/**
 * The outputs a plan's summary carries (BLP-17): the stack's `url` and `console_url`, read from the state the plan
 * started from (`prior_state`: what exists, not what the plan would create) and only when the output is not
 * sensitive and is an http(s) link of at most 300 printable ASCII characters. A plan shows a sensitive output in
 * clear, so `sensitive == false` is the one thing that keeps it out, and an output without it is left out too.
 * `\\z` and not `$`, which would let a trailing newline through. The bounds are the plan-summary route's.
 */
export const OUTPUTS_FILTER = [
  String.raw`def link(n): (.prior_state.values.outputs // {})[n] | select(type == "object" and .sensitive == false and (.value | type) == "string" and (.value | length) <= 300 and (.value | test("^https?://[!-~]+\\z"))) | .value;`,
  '{url: (link("url") // null), consoleUrl: (link("console_url") // null)} | with_entries(select(.value != null))',
].join(" ");

/**
 * The estimate a plan's cost job posts, from `infracost diff --format json` (its totals are strings,
 * its currency a code): the delta, the new total, the currency and the tool, as numbers. Anything that
 * is not a usable estimate (a field missing, not a number, out of range, a lower-case currency) is no
 * output at all and the job posts none: never a guess. The bounds are the plan-summary route's.
 */
export const COST_FILTER = [
  'def amount: (if type == "string" then tonumber else . end) | select(type == "number" and . >= -1e12 and . <= 1e12);',
  '(.currency | select(type == "string" and test("^[A-Z]{3}$"))) as $currency',
  "| (.totalMonthlyCost | amount | select(. >= 0)) as $total",
  "| (.diffTotalMonthlyCost | amount) as $delta",
  "| {monthlyDelta: $delta, monthlyTotal: $total, currency: $currency, tool: $tool}",
].join(" ");

/**
 * GitLab-managed state (D9) as the Terraform `http` backend reads it: the state is named after the
 * stack (a closed character set, so a safe path segment), locking is GitLab's POST/DELETE rather
 * than the backend's LOCK/UNLOCK, and the password is the job's own token by reference, never a value.
 */
const stateVariables = (name: string) => {
  const address = `$CI_API_V4_URL/projects/$CI_PROJECT_ID/terraform/state/${name}`;
  return {
    TF_HTTP_ADDRESS: address,
    TF_HTTP_LOCK_ADDRESS: `${address}/lock`,
    TF_HTTP_LOCK_METHOD: "POST",
    TF_HTTP_UNLOCK_ADDRESS: `${address}/lock`,
    TF_HTTP_UNLOCK_METHOD: "DELETE",
    TF_HTTP_USERNAME: "gitlab-ci-token",
    TF_HTTP_PASSWORD: "$CI_JOB_TOKEN",
    TF_HTTP_RETRY_WAIT_MIN: "5",
  };
};

// The job signs in with its id_token; the summary job and a plan job of a stack with an environment both start so.
const LOGIN = ['login="$(orch ci login)"', 'eval "$login"'];

/**
 * Whether a stack's jobs use the platform's state (STATE-5): it says `state: orch` and its backend is one the
 * platform wires (`http`, or Terragrunt's, as for GitLab's state). Any other backend, or none, is left as it is.
 */
export const usesPlatformState = (s: Stack) =>
  s.state === "orch" && (s.backend === "http" || s.backend === "unchecked");

/**
 * Where a stack's Terraform state is kept, as its jobs are wired: the platform's (`orch`), GitLab's managed state
 * (`gitlab`), a backend of its own or local state, left as the code has it (`own`), or none at all (a DNS zone).
 */
export type StateMode = "orch" | "gitlab" | "own" | "none";
export const stateModeOf = (s: Stack): StateMode =>
  s.tool === "dnscontrol"
    ? "none"
    : usesPlatformState(s)
      ? "orch"
      : s.backend === "http" || s.backend === "unchecked"
        ? "gitlab"
        : "own";

/**
 * The lines that point a job's Terraform at the platform's state (ADR-0017, `docs/ci.md`): sign in for the
 * state token (`ORCH_STATE_TOKEN`, with the organization and project ids), then name the state as the `http`
 * backend reads it. The shell resolves the address and the password: no value is in the pipeline. Only an
 * apply locks (POST and DELETE, as GitLab's state does): a plan's token reads, and on a branch that is not
 * protected cannot write, so a plan never asks for the lock.
 */
const platformState = (name: string, locks: boolean) => [
  'login="$(orch ci login --state)"',
  'eval "$login"',
  `export TF_HTTP_ADDRESS="$ORCH_API_URL/organizations/$ORCH_ORG/projects/$ORCH_PROJECT/state/${name}" TF_HTTP_USERNAME=ci TF_HTTP_PASSWORD="$ORCH_STATE_TOKEN"`,
  ...(locks
    ? [
        'export TF_HTTP_LOCK_ADDRESS="$TF_HTTP_ADDRESS/lock" TF_HTTP_LOCK_METHOD=POST TF_HTTP_UNLOCK_ADDRESS="$TF_HTTP_ADDRESS/lock" TF_HTTP_UNLOCK_METHOD=DELETE',
      ]
    : []),
];

/**
 * The lines of a summary job that judge a stack's plan: fetch each set from GitLab with the job's
 * own token, run conftest on the plan, keep the names of the rules that fired and post them. Fails
 * closed: whatever goes wrong before the answer is read (a set that cannot be fetched, a policy
 * that does not load, conftest not there, an answer that is not a result) posts `evaluated: false`,
 * which the platform takes as a denial. Only a failure to post leaves no verdict, and with none
 * the platform will not apply the stack either.
 */
function policyScript(name: string, dir: string, sets: readonly PolicySet[], path: string) {
  const dirs = sets.map((set, i) => (set.path === "." ? `policy/${i}` : `policy/${i}/${set.path}`));
  const chain = [
    ...sets.flatMap((set, i) => [
      `curl --fail --silent --show-error --location --header "JOB-TOKEN: $CI_JOB_TOKEN" --output policy-${i}.tgz "$CI_API_V4_URL/projects/${encodeURIComponent(set.source)}/repository/archive.tar.gz?sha=${encodeURIComponent(set.ref)}"`,
      `mkdir -p policy/${i}`,
      `tar -xzf policy-${i}.tgz -C policy/${i} --strip-components=1`,
    ]),
    // conftest exits 1 for a denial as for a failure: what it printed decides, not how it ended
    `{ conftest test --no-color --output json --all-namespaces ${dirs.map((d) => `--policy ${d}`).join(" ")} ${inDir(dir, "plan.json")} > policy.json || :; }`,
    `jq -e -c -s --arg stack ${name} '${POLICY_FILTER}' policy.json > policy-verdict.json`,
  ].join(" && ");
  return [
    `${chain} || printf '{"stack":"${name}","evaluated":false}' > policy-verdict.json`,
    `curl --fail --silent --show-error --request POST --header "Authorization: Bearer $ORCH_TOKEN" --header "Content-Type: application/json" --data @policy-verdict.json "$ORCH_API_URL${path}"`,
  ];
}

/**
 * The lines of a cost job: the estimate of the stack's plan, kept as cost.json only when it is a
 * usable one. Every way to have none (no key on the runner, no tool, a tool that fails, an answer
 * that is not an estimate) ends the same, in no file and a job that ends well.
 */
const costScript = (dir: string) => [
  `{ [ -n "$INFRACOST_API_KEY" ] && infracost diff --path ${inDir(dir, "plan.json")} --format json > infracost.json && jq -e -c --arg tool infracost '${COST_FILTER}' infracost.json > cost.json; } || rm -f cost.json`,
];

/**
 * The summary of a DNS zone's plan, from `dnscontrol preview --report`: one entry per change line the tool
 * reports (`+ CREATE` / `- DELETE` / `± MODIFY <fqdn> <TYPE> <what>`), kept as the zone, the name inside it
 * (`@` for the apex) and the type, with the action. The rest of a line is the record's value and is dropped
 * here, in the runner: the summary never has it. A zone that is new reports only "Ensuring zone" and is one
 * create of the zone, and the note that NO_PURGE keeps the records it lists is no change; a line this does not
 * understand is one update of the zone, quoted nowhere. The counts are the actions, in the shape of a
 * Terraform plan's, so the platform takes both alike.
 */
export const DNS_SUMMARY_FILTER = [
  "[.[] | select(.correction_details != null) | .domain as $zone | .correction_details[]",
  // the note NO_PURGE adds: its header and the records it keeps, one `TYPE("name", value),` per line (seen in DNSControl 5.5.0)
  String.raw`| select(test("^[0-9]+ records? not being deleted because of NO_PURGE:\\z") or test("^[A-Z][A-Z0-9_]*\\(.*\\),?\\z") | not)`,
  String.raw`| (capture("^(?:\\+ CREATE|- DELETE|± MODIFY) (?<fqdn>[^ ]+) (?<type>[A-Z][A-Z0-9_]*)") // null) as $m`,
  String.raw`| (if test("^\\+ CREATE ") or test("^Ensuring zone ") then "create" elif test("^- DELETE ") then "delete" else "update" end) as $action`,
  String.raw`| {address: (if $m == null then $zone else "\($zone)/\(if $m.fqdn == $zone then "@" elif ($m.fqdn | endswith("." + $zone)) then $m.fqdn[:-($zone | length + 1)] else $m.fqdn end)/\($m.type)" end), actions: [$action]}] as $c`,
  "| {stack: $stack,",
  'add: ($c | map(select(.actions == ["create"])) | length),',
  'change: ($c | map(select(.actions == ["update"])) | length),',
  'destroy: ($c | map(select(.actions == ["delete"])) | length),',
  `resources: ($c | .[:${MAX_LISTED}])}`,
].join(" ");

/**
 * The job's check that every `$NAME` its `creds.json` names is a set, non-empty variable, which DNSControl does
 * not do (an unset one is an empty credential, not an error). The names are read from the file, outside `orch
 * run`, and tested inside it, where the environment's variables are; the message has the name, never a value.
 */
const CREDS_CHECK = String.raw`'for v in "$@"; do [ -n "$(printenv "$v")" ] || { echo "creds.json names \$$v, which is not set or is empty"; exit 1; }; done'`;
const CREDS_NAMES = `$(grep -o '"[$][A-Za-z_][A-Za-z0-9_]*"' creds.json | tr -d '"$')`;

/**
 * The change set of a DNS preview, as one line of JSON: every `[zone, change]` pair of the report, sorted, so the
 * order the tool happens to report them in does not matter and a different value, name, type or count does. An
 * apply compares the plan's with the one it just made (`cmp`, both files stay in the runner). `input` fails on an
 * empty file and the `error` on anything that is not a report, so a plan that cannot be read is never "the same
 * as" an empty one.
 */
const DNS_CHANGE_SET = `input | (if type == "array" then . else error("not a report") end) | [.[] | .domain as $z | (.correction_details // [])[] | [$z, .]] | sort`;

/**
 * The `<credkey> <zone>` pairs of an evaluated `dnsconfig.js` (`dnscontrol print-ir`), one per line: each zone with the
 * first provider it names. A name that is not a zone name, or a key that could be read as an option or break a shell
 * line, is left out: `\z` and not `$`, which would let a trailing newline through. Names come from the repository's
 * file, so they are checked here and not trusted because the file is the team's own.
 */
const DNS_IMPORT_PAIRS = String.raw`.domains[] | .name as $z | ((.dnsProviders // {}) | keys_unsorted | map(select(test("^[A-Za-z0-9_][A-Za-z0-9_.-]*\\z"))) | first) as $k | select($k != null and ($z | test("^[a-z0-9][a-z0-9.-]*\\z"))) | "\($k) \($z)"`;

/**
 * The draft `get-zones --format=js` writes is "a decent first draft": it declares its provider with an empty second
 * argument, which the stack's own `creds.json` makes redundant, and has no `NO_PURGE`, so a plan of it would delete
 * whatever the file does not list. The first sed drops the empty argument; the awk adds `NO_PURGE` after the `D(` line
 * and fails a draft that has none to add it to.
 */
const DNS_DRAFT_FIX = String.raw`sed 's/\(NewDnsProvider("[^"]*"\), "")/\1)/' "$f" | awk '{ print } /^D\(.*,$/ { print "\tNO_PURGE,"; added = 1 } END { exit !added }'`;

const isZone = (s: Stack) => s.tool === "dnscontrol";

// names that come from a user are shown quoted and cut short
const quoted = (s: string) => JSON.stringify(s.length > 64 ? `${s.slice(0, 64)}…` : s);
const inDir = (dir: string, file: string) => (dir === "." ? file : `${dir}/${file}`);

/**
 * The YAML of a child pipeline: one job per selected stack, in stages by wave, each waiting for the
 * selected stacks it depends on (through stacks that are not selected too), in the stack's own
 * `resource_group` so that two runs never touch a stack together.
 *
 * - every tool job gets the settings of the stack's GitLab-managed state, unless the stack declares
 *   another backend or none (see `stateVariables`).
 * - `plan` saves the plan and its JSON as artifacts and, in a later job that holds the platform's
 *   `id_token` and nothing of the cloud's, posts the counts to the platform.
 * - the plan job of a stack with an `environment` holds that `id_token` too, signs in, and runs
 *   each tool command through `orch run --prefix TF_VAR_`, so the environment's variables reach the
 *   tool as `TF_VAR_*` and nothing else: no value is ever in the pipeline. The image must hold `orch`.
 * - `apply` fetches the plan the given job saved and applies exactly that (the plan holds the values).
 *
 * Throws a `GenerateError` for a cycle, a stack with no tool version, an unknown stack, and any
 * name, path, version or option that could reach a shell or a job's configuration.
 */
export function generatePipeline(input: GenerateInput): string {
  const { action, select, stages, jobs } = buildPipeline(input);
  return `# Generated by orch: a child pipeline for ${action} of ${select.length} stack${select.length === 1 ? "" : "s"}. Do not edit.\n${stringify({ stages, ...jobs }, { lineWidth: 0 })}`;
}

/**
 * The jobs `generatePipeline` writes, before they are YAML, and the waves they run in. The plan of a run for a runner
 * that is not GitLab (`runPlan`) is read off these same jobs, so a command is written once.
 */
export function buildPipeline(input: GenerateInput) {
  const problems: string[] = [];
  const byName = new Map(input.stacks.map((s) => [s.name, s]));
  const select = [...new Set(input.select)].sort();

  const cloudTokens = input.cloudTokens ?? {};
  const cloud = Object.keys(cloudTokens).sort();
  for (const name of cloud) {
    const aud = cloudTokens[name] as string;
    // ORCH_* is the platform's own: a cloud token under that name would be mistaken for its id_token
    if (!VARIABLE.test(name) || name.startsWith("ORCH_")) {
      problems.push(`cloud token name ${quoted(name)} is not a usable variable name`);
    }
    if (!AUDIENCE.test(aud)) problems.push(`audience of cloud token ${quoted(name)} is not usable`);
  }
  for (const [tool, repo] of Object.entries(input.images ?? {})) {
    if (!repository.test(repo)) problems.push(`image for ${tool} is not an image repository`);
  }
  if (input.action === "plan") {
    if (!AUDIENCE.test(input.audience)) problems.push("audience is not usable");
    if (!API_URL.test(input.apiUrl)) {
      problems.push("apiUrl must be http(s)://host[:port][/path] with no trailing slash");
    }
    if (
      !PATH.test(input.summaryPath) ||
      input.summaryPath.split("/").some((s) => s === "." || s === "..")
    ) {
      problems.push("summaryPath must be a path starting with /");
    }
    if (!image.test(input.helperImage)) problems.push("helperImage is not an image reference");
  }
  if (input.action === "apply" && input.platform) {
    if (!AUDIENCE.test(input.platform.audience)) problems.push("platform.audience is not usable");
    if (!API_URL.test(input.platform.apiUrl)) {
      problems.push("platform.apiUrl must be http(s)://host[:port][/path] with no trailing slash");
    }
  }
  // the stacks of a plan that are estimated: the ones selected (a name that is not selected has no job)
  // (a DNS zone has no cost: its plan is no Terraform plan)
  const costed =
    input.action === "plan" && input.cost
      ? select.filter((n) => input.cost?.stacks.includes(n) && byName.get(n)?.tool !== "dnscontrol")
      : [];
  if (input.action === "plan" && input.cost && costed.length > 0 && !image.test(input.cost.image)) {
    problems.push("cost.image is not an image reference (an image with infracost and jq)");
  }

  const built = buildGraph(input.stacks.map((s) => ({ name: s.name, dependsOn: s.dependsOn })));
  if (!built.ok) problems.push(...built.errors.map((e) => e.message));

  if (select.length === 0) problems.push("no stack was selected");
  const repoOf = new Map<string, string>();
  const poolOf = new Map<string, PoolRef>();
  for (const name of select) {
    const s = byName.get(name);
    if (!s) {
      problems.push(`unknown stack ${quoted(name)}`);
      continue;
    }
    const at = `stack ${quoted(name)}`;
    if (!NAME.test(s.name)) problems.push(`${at} has a name that is not usable in a job`);
    if (!safeDir(s.path)) problems.push(`${at} has a path that is not usable in a job`);
    if (s.version === null) problems.push(`${at} has no version: set version in its stack.yml`);
    else if (!VERSION.test(s.version)) problems.push(`${at} has a version that is not usable`);
    if (s.environment !== undefined && !SLUG.test(s.environment)) {
      problems.push(`${at} has an environment that is not usable in a job`);
    }
    if (input.action === "plan" && input.policy) {
      const judged = setsFor(s.tags, input.policy.sets);
      for (const set of judged) {
        for (const p of policySetProblems(set)) {
          // the same set judges every stack that carries its tag: say it once
          const message = `policy set ${quoted(set.name)}: ${p}`;
          if (!problems.includes(message)) problems.push(message);
        }
      }
      if (judged.length > 0 && isZone(s)) {
        // fail closed: a zone left out of a set that reaches it would be applied unjudged
        problems.push(
          `${at} is a DNS zone, which policy sets cannot judge (they judge Terraform plans): take the tag of the set off it`,
        );
      } else if (judged.length > 0) {
        if (!(input.policy.image && image.test(input.policy.image))) {
          problems.push(
            `${at} is judged by policy, so its summary job runs conftest: pass policy.image (an image with conftest, orch, curl and jq)`,
          );
        }
        if (!PATH.test(input.policy.path))
          problems.push("policy.path must be a path starting with /");
      }
    }
    const found = resolvePool(s.pool, input.pools ?? []);
    if (found.kind === "unknown") {
      problems.push(
        `${at} names the worker pool ${quoted(found.name)}, which the organization does not have`,
      );
    } else if (found.kind === "disabled") {
      problems.push(
        `${at} ${s.pool === undefined ? "uses the default" : "names the"} worker pool ${quoted(found.name)}, which is disabled`,
      );
    } else if (found.kind === "pool") {
      poolOf.set(name, found.pool);
      // a pool says "tags" and "image" in words the YAML must not misread: judged where they are written, once per pool
      const p = found.pool;
      const named = `worker pool ${quoted(p.name)}`;
      const bad =
        p.tags.length === 0
          ? `${named} has no tags, so its jobs would go to any runner`
          : !p.tags.every((t) => RUNNER_TAG.test(t))
            ? `${named} has a tag that is not usable in a job`
            : p.image !== null && !image.test(p.image)
              ? `${named} has an image that is not usable`
              : undefined;
      if (bad && !problems.includes(bad)) problems.push(bad);
    }
    const repo = input.images?.[s.tool] ?? IMAGES[s.tool];
    // the pool's image holds the tool (and orch) by the pool's own say-so: the stock image is not needed
    if (found.kind === "pool" && found.pool.image !== null) {
      // nothing more to check: the image is used as it is given
    } else if (repo === undefined) {
      problems.push(`${at} uses ${s.tool}, which needs an image: pass images.${s.tool}`);
    } else {
      repoOf.set(name, repo);
      // the tool's stock image has no orch to sign in with
      if (input.action === "plan" && s.environment !== undefined && !input.images?.[s.tool]) {
        problems.push(
          `${at} has an environment, so its plan job runs orch: pass images.${s.tool} (an image with ${s.tool} and orch)`,
        );
      } else if (input.action === "apply" && isZone(s) && !input.images?.[s.tool]) {
        // DNSControl has no saved plan: the apply reads the plan's report (jq, wget) and, in an environment, signs in (orch)
        problems.push(
          `${at} is a DNS zone, so its apply job reads the plan with jq and wget, and runs orch with an environment: pass images.${s.tool} (an image with ${s.tool}, jq, wget and orch)`,
        );
      } else if (usesPlatformState(s) && !input.images?.[s.tool]) {
        problems.push(
          `${at} keeps its state on the platform, so its jobs run orch: pass images.${s.tool} (an image with ${s.tool} and orch)`,
        );
      }
    }
    if (usesPlatformState(s) && input.action === "apply" && !input.platform) {
      problems.push(
        `${at} keeps its state on the platform, so its jobs sign in: pass platform (apiUrl and audience)`,
      );
    }
    if (input.action === "apply" && isZone(s) && s.environment !== undefined && !input.platform) {
      problems.push(
        `${at} has an environment, so its apply job signs in: pass platform (apiUrl and audience)`,
      );
    }
    if (input.action === "apply") {
      const job = input.planJobs[name];
      if (!(Number.isSafeInteger(job) && (job as number) > 0)) {
        problems.push(`${at} has no saved plan to apply`);
      }
    }
  }
  if (problems.length > 0 || !built.ok) throw new GenerateError(problems);

  const { graph } = built;
  const chosen = new Set(select);
  const waves = graph.waves(select);
  const stageOf = new Map(waves.flatMap((w, i) => w.map((n) => [n, `wave-${i}`] as const)));
  // the nearest selected stacks it depends on: a stack that is not selected is looked through
  const needsOf = (name: string) => {
    const out = new Set<string>();
    const seen = new Set<string>();
    const walk = (n: string) => {
      for (const d of graph.dependencies(n)) {
        if (seen.has(d)) continue;
        seen.add(d);
        if (chosen.has(d)) out.add(d);
        else walk(d);
      }
    };
    walk(name);
    return [...out].sort();
  };
  const tooMany = select.flatMap((name) => {
    const n = needsOf(name).length;
    return n > MAX_NEEDS
      ? [
          `stack ${quoted(name)} would wait for ${n} stacks; GitLab allows ${MAX_NEEDS} needs per job`,
        ]
      : [];
  });
  if (tooMany.length > 0) throw new GenerateError(tooMany);

  const { action } = input;
  // a stack on a pool asks for its runners; the key is left out otherwise, so a pipeline with no pools is as it was.
  // A copy for every job: one array in several jobs is written as a YAML anchor and aliases, which a reader of the file should not have to follow.
  const tagsOf = (name: string) => {
    const pool = poolOf.get(name);
    return pool ? { tags: [...pool.tags] } : {};
  };
  const toolJob = (name: string, script: string[], extra: object) => {
    const s = byName.get(name) as Stack;
    // the plan of a stack with an environment signs in to the platform, and so does any job of a stack
    // whose state is there (an apply otherwise never does), and the apply of a zone with an environment;
    // an apply is told where the platform is
    const inEnvironment = (input.action === "plan" || isZone(s)) && s.environment !== undefined;
    const onPlatform = usesPlatformState(s);
    const platform =
      inEnvironment || onPlatform ? (input.action === "plan" ? input : input.platform) : undefined;
    // GitLab's state settings only where the stack uses them: `http`, or Terragrunt, whose backend is not
    // read here. A backend of its own is passed through (its code and the runner's credentials
    // reach it) and a stack with none has local state, which these would not change. A stack on the
    // platform's state sets its own in the script, after it has signed in.
    const variables = {
      ...(stateModeOf(s) === "gitlab" ? stateVariables(name) : {}),
      ...(platform ? { ORCH_API_URL: platform.apiUrl } : {}),
    };
    const idTokens = {
      ...Object.fromEntries(cloud.map((n) => [n, { aud: cloudTokens[n] }])),
      ...(platform ? { ORCH_ID_TOKEN: { aud: platform.audience } } : {}),
    };
    return {
      stage: stageOf.get(name),
      image: {
        name: poolOf.get(name)?.image ?? `${repoOf.get(name)}:${s.version}`,
        entrypoint: [""],
      },
      ...tagsOf(name),
      resource_group: `stack-${name}`,
      // `access`: the job reads the environment's variables; it deploys nothing to it
      ...(inEnvironment ? { environment: { name: s.environment, action: "access" } } : {}),
      ...(Object.keys(variables).length > 0 ? { variables } : {}),
      needs: needsOf(name).map((n) => ({ job: `${action}:${n}`, artifacts: false })),
      ...(Object.keys(idTokens).length > 0 ? { id_tokens: idTokens } : {}),
      // the state token ends with the job's own (an hour at most) and so does the lock it holds: a job that ran longer would lose the state mid-apply
      ...(onPlatform ? { timeout: STATE_JOB_TIMEOUT } : {}),
      ...extra,
      script: s.path === "." ? script : [`cd ${s.path}`, ...script],
    };
  };

  const jobs: Record<string, unknown> = {};
  for (const name of waves.flat()) {
    const stackOf = byName.get(name) as Stack;
    const { path: dir, tool, environment } = stackOf;
    const onPlatform = usesPlatformState(stackOf);
    // A zone's lines, plan and apply alike. Everything the tool prints holds record values (its errors too), so it
    // goes to a file the job keeps for developers and never to the log; what the log says is fixed.
    const run = environment === undefined ? "" : "orch run -- ";
    const credsLine = `${run}sh -c ${CREDS_CHECK} sh ${CREDS_NAMES}`;
    const previewOf = (more: string) =>
      `{ dnscontrol check && ${run}dnscontrol preview --report report.json${more}; } > preview.txt 2>&1 || { echo "dnscontrol failed; its output is the preview.txt artifact, which developers can read"; exit 1; }`;
    const previewLine = previewOf("");
    // The plan also keeps the evaluated config, for the lint (DNS-11): its stdout is the file, its errors are the preview's.
    const planPreviewLine = previewOf(" && dnscontrol print-ir > ir.json");
    if (input.action === "plan") {
      // the tool commands that read the configuration get the environment's variables as TF_VAR_*
      const withVariables = (line: string) =>
        environment === undefined ? line : `orch run --prefix TF_VAR_ -- ${line}`;
      // A zone: check offline, then preview with a machine-readable report
      const zonePlan = isZone(stackOf)
        ? toolJob(name, [...(environment === undefined ? [] : LOGIN), credsLine, planPreviewLine], {
            interruptible: true,
            artifacts: {
              paths: [
                inDir(dir, "report.json"),
                inDir(dir, "preview.txt"),
                // record values too: for developers, like the preview
                inDir(dir, "ir.json"),
              ],
              expire_in: EXPIRE_IN,
              access: "developer",
              // a failed preview is the one a developer must read
              when: "always",
            },
          })
        : undefined;
      jobs[`plan:${name}`] =
        zonePlan ??
        toolJob(
          name,
          [
            ...(environment === undefined ? [] : LOGIN),
            ...(onPlatform ? platformState(name, false) : []),
            withVariables(`${tool} init -input=false`),
            // a plan on the platform's state does not lock (see `platformState`)
            withVariables(
              `${tool} plan -input=false ${onPlatform ? "-lock=false" : `-lock-timeout=${LOCK_TIMEOUT}`} -out=plan.tfplan`,
            ),
            withVariables(`${tool} show -json plan.tfplan > plan.json`),
          ],
          {
            // a newer push may cancel a plan; an apply is never cut off
            interruptible: true,
            artifacts: {
              paths: [inDir(dir, "plan.tfplan"), inDir(dir, "plan.json")],
              expire_in: EXPIRE_IN,
              // a plan holds the values of secrets: not for every member who can see the pipeline
              access: "developer",
            },
          },
        );
      // DNS-9: read the zones the config points at into a starting config. Manual, and an extra: it never blocks
      // the pipeline, and nothing waits for it. Only with the custom image, which has jq (the stock one has not).
      if (isZone(stackOf) && input.images?.[tool]) {
        const failed = (what: string) => `{ echo "${what}"; exit 1; }`;
        jobs[`import:${name}`] = toolJob(
          name,
          [
            ...(environment === undefined ? [] : LOGIN),
            credsLine,
            `{ dnscontrol print-ir > ir.json && jq -r '${DNS_IMPORT_PAIRS}' ir.json > pairs.txt; } 2> import.log || ${failed("dnscontrol could not read dnsconfig.js; its output is the import.log artifact, which developers can read")}`,
            `[ -s pairs.txt ] || ${failed("dnsconfig.js declares no zone with a provider to import from")}`,
            "mkdir -p import",
            `ok=1; while read -r key zone; do ${run}dnscontrol get-zones --format=js --out="import/$zone.raw" "$key" "$zone" < /dev/null && [ -s "import/$zone.raw" ] || ok=0; done < pairs.txt > import.log 2>&1; [ "$ok" = 1 ] || ${failed("dnscontrol get-zones failed; its output is the import.log artifact, which developers can read")}`,
            `ok=1; for f in import/*.raw; do ${DNS_DRAFT_FIX} > "\${f%.raw}.js" || ok=0; done; [ "$ok" = 1 ] || ${failed("a draft has no D() line to add NO_PURGE to; the drafts are in the import artifact, which developers can read")}`,
            "rm -f import/*.raw",
          ],
          {
            when: "manual",
            allow_failure: true,
            needs: [],
            interruptible: true,
            artifacts: {
              paths: [inDir(dir, "import/"), inDir(dir, "import.log")],
              expire_in: EXPIRE_IN,
              // the drafts hold the zone's record values, and so does a failed run's log
              access: "developer",
              when: "always",
            },
          },
        );
      }
      const estimated = costed.includes(name) && input.cost;
      if (estimated) {
        jobs[`estimate:${name}`] = {
          stage: "estimate",
          image: { name: estimated.image, entrypoint: [""] },
          ...tagsOf(name),
          needs: [{ job: `plan:${name}`, artifacts: true }],
          // an estimate is an extra: whatever goes wrong with the job, the pipeline goes on without it
          allow_failure: true,
          interruptible: true,
          artifacts: { paths: ["cost.json"], expire_in: EXPIRE_IN },
          script: costScript(dir),
        };
      }
      const judged = input.policy ? setsFor(byName.get(name)?.tags ?? [], input.policy.sets) : [];
      jobs[`summary:${name}`] = {
        stage: "summary",
        image: {
          name: (judged.length > 0 && input.policy?.image) || input.helperImage,
          entrypoint: [""],
        },
        ...tagsOf(name),
        needs: [
          { job: `plan:${name}`, artifacts: true },
          ...(estimated ? [{ job: `estimate:${name}`, artifacts: true }] : []),
        ],
        id_tokens: { ORCH_ID_TOKEN: { aud: input.audience } },
        variables: { ORCH_API_URL: input.apiUrl },
        script: [
          ...LOGIN,
          isZone(stackOf)
            ? `jq -c --arg stack ${name} '${DNS_SUMMARY_FILTER}' ${inDir(dir, "report.json")} > summary.json`
            : `jq -c --arg stack ${name} '${SUMMARY_FILTER}' ${inDir(dir, "plan.json")} > summary.json`,
          // A zone's lint report rides on the summary when there is one; if the lint cannot run (no ir.json from an older
          // plan job, an orch that does not know the command) the summary is as it was, and the merge request shows no lint.
          ...(isZone(stackOf)
            ? [
                `orch dns lint${stackOf.dnsPrune === true ? " --prune" : ""} < ${inDir(dir, "ir.json")} > lint.json || rm -f lint.json`,
                "if [ -s lint.json ] && jq -c --slurpfile lint lint.json '. + {lint: $lint[0]}' summary.json > summary.merged; then mv summary.merged summary.json; fi",
              ]
            : []),
          // the estimate rides on the summary when there is a readable one; without it the summary is as it was
          ...(estimated
            ? [
                "if [ -s cost.json ] && jq -c --slurpfile cost cost.json '. + {cost: $cost[0]}' summary.json > summary.merged; then mv summary.merged summary.json; fi",
              ]
            : []),
          // so do the outputs of the state the plan started from; a plan that cannot be read leaves the summary as it was
          ...(isZone(stackOf)
            ? []
            : [
                `if jq -c '${OUTPUTS_FILTER}' ${inDir(dir, "plan.json")} > outputs.json && jq -c --slurpfile outputs outputs.json '. + {outputs: $outputs[0]}' summary.json > summary.merged; then mv summary.merged summary.json; fi`,
              ]),
          `curl --fail --silent --show-error --request POST --header "Authorization: Bearer $ORCH_TOKEN" --header "Content-Type: application/json" --data @summary.json "$ORCH_API_URL${input.summaryPath}"`,
          ...(judged.length > 0 && input.policy
            ? policyScript(name, dir, judged, input.policy.path)
            : []),
        ],
      };
    } else if (isZone(stackOf)) {
      // DNSControl has no saved plan: preview again, and push only if it is the change set the plan reported
      jobs[`apply:${name}`] = toolJob(
        name,
        [
          ...(environment === undefined ? [] : LOGIN),
          credsLine,
          `wget -q --header "JOB-TOKEN: $CI_JOB_TOKEN" -O plan-report.json "$CI_API_V4_URL/projects/$CI_PROJECT_ID/jobs/${input.planJobs[name]}/artifacts/${inDir(dir, "report.json")}"`,
          `jq -n -c '${DNS_CHANGE_SET}' plan-report.json > planned.txt`,
          previewLine,
          `jq -n -c '${DNS_CHANGE_SET}' report.json > current.txt`,
          `cmp -s planned.txt current.txt || { echo "the zone's changes are not the ones that were planned: nothing was pushed. Plan again."; exit 1; }`,
          `${run}dnscontrol push > push.txt 2>&1 || { echo "dnscontrol push failed; its output is the push.txt artifact, which developers can read"; exit 1; }`,
        ],
        {
          artifacts: {
            paths: [inDir(dir, "preview.txt"), inDir(dir, "push.txt")],
            expire_in: EXPIRE_IN,
            access: "developer",
            // a failed push is the one a developer must read
            when: "always",
          },
        },
      );
    } else {
      jobs[`apply:${name}`] = toolJob(
        name,
        [
          ...(onPlatform ? platformState(name, true) : []),
          `wget -q --header "JOB-TOKEN: $CI_JOB_TOKEN" -O plan.tfplan "$CI_API_V4_URL/projects/$CI_PROJECT_ID/jobs/${input.planJobs[name]}/artifacts/${inDir(dir, "plan.tfplan")}"`,
          `${tool} init -input=false`,
          `${tool} apply -input=false -lock-timeout=${LOCK_TIMEOUT} plan.tfplan`,
        ],
        {},
      );
    }
  }

  const stages = [
    ...waves.map((_, i) => `wave-${i}`),
    ...(costed.length > 0 ? ["estimate"] : []),
    ...(action === "plan" ? ["summary"] : []),
  ];
  return { action, select, stages, jobs, waves };
}
