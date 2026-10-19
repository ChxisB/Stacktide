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
  const costed =
    input.action === "plan" && input.cost
      ? select.filter((n) => input.cost?.stacks.includes(n))
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
      if (judged.length > 0) {
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
    // whose state is there (an apply otherwise never does); an apply is told where the platform is
    const envPlan = input.action === "plan" && s.environment !== undefined;
    const onPlatform = usesPlatformState(s);
    const platform =
      envPlan || onPlatform ? (input.action === "plan" ? input : input.platform) : undefined;
    // GitLab's state settings only where the stack uses them: `http`, or Terragrunt, whose backend is not
    // read here. A backend of its own is passed through (its code and the runner's credentials
    // reach it) and a stack with none has local state, which these would not change. A stack on the
    // platform's state sets its own in the script, after it has signed in.
    const variables = {
      ...((s.backend === "http" || s.backend === "unchecked") && !onPlatform
        ? stateVariables(name)
        : {}),
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
      ...(envPlan ? { environment: { name: s.environment, action: "access" } } : {}),
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
    if (input.action === "plan") {
      // the tool commands that read the configuration get the environment's variables as TF_VAR_*
      const withVariables = (line: string) =>
        environment === undefined ? line : `orch run --prefix TF_VAR_ -- ${line}`;
      jobs[`plan:${name}`] = toolJob(
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
          `jq -c --arg stack ${name} '${SUMMARY_FILTER}' ${inDir(dir, "plan.json")} > summary.json`,
          // the estimate rides on the summary when there is a readable one; without it the summary is as it was
          ...(estimated
            ? [
                "if [ -s cost.json ] && jq -c --slurpfile cost cost.json '. + {cost: $cost[0]}' summary.json > summary.merged; then mv summary.merged summary.json; fi",
              ]
            : []),
          `curl --fail --silent --show-error --request POST --header "Authorization: Bearer $ORCH_TOKEN" --header "Content-Type: application/json" --data @summary.json "$ORCH_API_URL${input.summaryPath}"`,
          ...(judged.length > 0 && input.policy
            ? policyScript(name, dir, judged, input.policy.path)
            : []),
        ],
      };
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
  return `# Generated by orch: a child pipeline for ${action} of ${select.length} stack${select.length === 1 ? "" : "s"}. Do not edit.\n${stringify({ stages, ...jobs }, { lineWidth: 0 })}`;
}
