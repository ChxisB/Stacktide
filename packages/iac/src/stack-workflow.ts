// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are GitHub Actions expressions, made of `${{ ... }}`
import { stringify } from "yaml";
import {
  GenerateError,
  isApiUrl,
  type PlanInput,
  type Platform,
  SUMMARY_FILTER,
} from "./pipeline-gen";
import { setsFor } from "./policy";
import { resolvePool } from "./pool";
import { type Judged, judgedSchema, type RunPlan, runPlan } from "./run-plan";
import type { Stack } from "./scan";

// FRG-18: GitHub cannot be handed a generated pipeline the way GitLab is (a child pipeline per run), and a
// dispatch takes only declared inputs. So the workflow is fixed, the same for every run: it is dispatched with the
// run's id, trades its Actions identity token for the platform's, reads the run's plan (FRG-17) and runs it.

/** Where the onboarding commits the workflow. */
export const STACK_WORKFLOW_FILE = ".github/workflows/orch-stacks.yml";

/**
 * How many levels of the dependency graph the file has room for: a matrix cannot be sized by the plan, so each level is a
 * job of its own. shortcut: a deeper graph is refused with a message, raise this (and the snapshot) when one is met.
 */
export const STACK_WORKFLOW_LEVELS = 6;

// Same commit as the templates' workflows (checkout v7.0.1): pinned, never a tag a repository could move.
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const RUNNER = "ubuntu-latest";
// A tighter set than the GitLab generator's, as the audience is written to the file as a value an expression could read: no `$`, `{` or quote.
const WORKFLOW_AUDIENCE = /^[A-Za-z0-9._~:/@+-]{1,255}$/;
const UUID = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

// An identity token of the Actions run, for an audience. Needs `id-token: write`, and curl and jq on the runner.
const MINT = `mint() {
  curl --fail --silent --show-error --header "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$(jq -rn --arg a "$1" '$a|@uri')" | jq -er .value
}`;
const NEEDS_TOKEN = `[ -n "$ACTIONS_ID_TOKEN_REQUEST_URL" ] || { echo "the job has no identity token: the workflow needs the permission id-token: write" >&2; exit 1; }`;

/**
 * The environment every apply job names (FRG-29). GitHub holds a job that names an environment with required reviewers
 * until one of them approves, which is the only gate an apply on GitHub has; the platform reads the environment's rules
 * before it asks for an apply (`requireApplyGate`). A name that is the same for every project, until one is configurable.
 */
export const APPLY_ENVIRONMENT = "orch-apply";

/** The name a dispatch gives its run (the file's `run-name`): how the platform finds the run it started (FRG-30). */
export const stackRunName = (runId: string, action: "plan" | "apply") => `orch ${runId} ${action}`;

const SHA = "^[0-9a-f]{40}$";

const levelOutputs = Array.from({ length: STACK_WORKFLOW_LEVELS }, (_, i) => `level${i}`);

const FETCH = `set -eo pipefail
uuid='${UUID}'
[[ "$RUN_ID" =~ $uuid ]] || { echo "run_id is not the id of a run" >&2; exit 1; }
[ "$ACTION" = plan ] || [ "$ACTION" = apply ] || { echo "action is neither plan nor apply" >&2; exit 1; }
${NEEDS_TOKEN}
${MINT}
id_token="$(mint "$ORCH_AUDIENCE")"
echo "::add-mask::$id_token"
exchange="$(jq -n --arg t "$id_token" '{id_token: $t}' | curl --fail --silent --show-error --request POST --header "Content-Type: application/json" --data @- "$ORCH_API_URL/auth/ci/exchange")"
token="$(jq -er .token <<<"$exchange")"
echo "::add-mask::$token"
org="$(jq -er .organizationId <<<"$exchange")"
project="$(jq -er .projectId <<<"$exchange")"
[[ "$org" =~ $uuid && "$project" =~ $uuid ]] || { echo "the platform answered with a project that is not an id" >&2; exit 1; }
plan="$(curl --fail --silent --show-error --header "Authorization: Bearer $token" "$ORCH_API_URL/organizations/$org/projects/$project/runs/$RUN_ID/plan?action=$ACTION")"
jq -e --arg a "$ACTION" '.action == $a' <<<"$plan" > /dev/null || { echo "the platform answered with the plan of another action" >&2; exit 1; }
sha=""
if [ "$ACTION" = apply ]; then
  sha="$(jq -r '.sha // ""' <<<"$plan")"
  shaRe='${SHA}'
  [[ "$sha" =~ $shaRe ]] || { echo "the plan of an apply names no commit to apply" >&2; exit 1; }
fi
depth="$(jq -e '.levels | length' <<<"$plan")"
[ "$depth" -le ${STACK_WORKFLOW_LEVELS} ] || { echo "the run's stacks are in $depth levels; this workflow has room for ${STACK_WORKFLOW_LEVELS}" >&2; exit 1; }
{ for i in ${levelOutputs.map((_, i) => i).join(" ")}; do echo "level$i=$(jq -c --argjson i "$i" '.levels[$i] // []' <<<"$plan")"; done; echo "action=$ACTION"; echo "sha=$sha"; } >> "$GITHUB_OUTPUT"`;

// The jobs of one stack run in the tool's image on the host's Docker, one after the other, in the same working tree: the summary
// reads the plan the plan job wrote, and no plan leaves the machine (a GitHub artifact is open to everyone who can read the repository).
// shortcut: only plan and summary (or, for an apply, plan and apply); a plan holding an estimate or policy is refused before the file is asked for it (`githubRunPlan`).
const levelScript = (kinds: string, before = "", after = "") => `set -eo pipefail
${NEEDS_TOKEN}
${MINT}
${before}for kind in ${kinds}; do
  job="$(jq -c --arg k "$kind" '.jobs[$k] // empty' <<<"$STACK")"
  [ -n "$job" ] || continue
  (
    set --
    envfile="$(mktemp)"
    jq -r '.env | to_entries[] | if (.key | test("^[A-Za-z_][A-Za-z0-9_]*$")) and (.value | test("[\\r\\n]") | not) then "\\(.key)=\\(.value)" else error("a variable that cannot be passed") end' <<<"$job" > "$envfile"
    tokens="$(jq -r '.idTokens | to_entries[] | [.key, .value] | @tsv' <<<"$job")"
    while IFS=$'\\t' read -r var aud; do
      [ -n "$var" ] || continue
      value="$(mint "$aud")"
      echo "::add-mask::$value"
      export "$var=$value"
      set -- "$@" --env "$var"
    done <<<"$tokens"
    commands="$(jq -r '.commands | join("\\n")' <<<"$job")"
    image="$(jq -r .image <<<"$job")"
    docker run --rm --volume "$PWD:/work" --workdir /work --env-file "$envfile" "$@" --entrypoint sh "$image" -e -c "$commands"
    rm -f "$envfile"
  )
${after}done`;
const LEVEL = levelScript("plan summary");

// An apply (FRG-29) has no saved plan to take: a GitHub artifact is open to everyone who can read the repository, and a plan holds the
// values of secrets. So it plans again, on the commit that was judged and after the reviewers have let the job start, and applies that
// plan only if its changes are the ones the platform judged: the same counts, and the same address and actions of each resource.
// The platform's `judged` and the new plan are both read through the summary's own filter, so neither holds a value.
// shortcut: the changes are compared, not the values; a value that changed between the plan and the apply (an input read at plan time) is applied.
const APPLY = levelScript(
  "plan apply",
  `jq -e '.jobs.plan and .jobs.apply and (.judged | type == "object")' <<<"$STACK" > /dev/null || { echo "the platform's plan for $(jq -r .name <<<"$STACK") has no plan job, no apply job or no judged changes: nothing was applied" >&2; exit 1; }
`,
  `  if [ "$kind" = plan ]; then
    have="$(jq -c --arg stack "$(jq -r .name <<<"$STACK")" '${SUMMARY_FILTER}' "$(jq -r .path <<<"$STACK")/plan.json")" || { echo "the new plan of $(jq -r .name <<<"$STACK") could not be read: nothing was applied" >&2; exit 1; }
    jq -en --argjson have "$have" --argjson want "$(jq -c .judged <<<"$STACK")" 'def norm: del(.stack) | .resources |= sort_by(.address); ($have | norm) == ($want | norm)' > /dev/null || { echo "the changes of $(jq -r .name <<<"$STACK") are not the ones that were judged: nothing was applied. Plan again." >&2; exit 1; }
  fi
`,
);

/** Checks the platform's address and audience; what is written into the file is nothing else. */
function checked(platform: Platform) {
  const problems: string[] = [];
  if (!isApiUrl(platform.apiUrl)) {
    problems.push("apiUrl must be http(s)://host[:port][/path] with no trailing slash");
  }
  if (!WORKFLOW_AUDIENCE.test(platform.audience)) {
    problems.push("audience is not usable in a workflow: letters, digits and . _ ~ : / @ + - only");
  }
  if (problems.length > 0) throw new GenerateError(problems);
}

/**
 * The text of `.github/workflows/orch-stacks.yml` (FRG-18, FRG-29): dispatched with a `run_id` and an `action`, named
 * `orch <run_id> <action>` so that the platform finds the run it started, then a `fetch` job that reads the run's plan
 * from the platform, and one matrix job per level, each waiting for the one before: `level-N` plans, `apply-N` applies.
 * The file holds nothing of any run: the same text for every one.
 *
 * - the Actions identity token is the only credential: exchanged for the platform's token, which is masked in the log.
 *   No secret of the repository is read (`secrets.*`), no plan is uploaded, and a value from the plan or from the
 *   dispatch reaches a script only through the environment, never an expression written into it.
 * - `fail-fast` is off, so a level finishes; the next level does not start if any stack of the one before failed. That is
 *   stricter than GitLab, where a stack waits only for the stacks it depends on. shortcut: the GitLab wording per stack
 *   needs one job per stack, which a static file cannot have.
 * - no `concurrency`: a plan takes no lock, and a group would cancel a waiting run without a word. shortcut: two
 *   applies of one stack at once are stopped by the state's lock when the stack is on the platform's state, by nothing
 *   when it is on a state of its own; add a group per stack when that is met.
 * - an apply job names `APPLY_ENVIRONMENT`, so GitHub holds it for the environment's reviewers; each level is a job, so
 *   a reviewer is asked once for every level. It checks out the commit that was judged, plans again and applies only
 *   the changes the platform judged (see `APPLY`).
 *
 * Throws a `GenerateError` for an address or audience that is not usable.
 */
export function renderStackWorkflow(platform: Platform): string {
  checked(platform);
  // A job of one stack of a level; an apply job names the environment and runs the commit that was judged.
  const stackJob = (apply: boolean, i: number) => ({
    name: `${apply ? "apply" : "plan"}:\${{ matrix.stack.name }}`,
    needs: i === 0 ? "fetch" : ["fetch", `${apply ? "apply" : "level"}-${i - 1}`],
    if: `needs.fetch.outputs.action == '${apply ? "apply" : "plan"}' && needs.fetch.outputs.level${i} != '[]'`,
    "runs-on": RUNNER,
    ...(apply ? { environment: APPLY_ENVIRONMENT } : {}),
    // the platform's state token lasts an hour at most (STATE_JOB_TIMEOUT in the GitLab generator)
    "timeout-minutes": 60,
    strategy: {
      "fail-fast": false,
      matrix: { stack: `\${{ fromJSON(needs.fetch.outputs.level${i}) }}` },
    },
    steps: [
      {
        uses: CHECKOUT,
        with: {
          ...(apply ? { ref: "${{ needs.fetch.outputs.sha }}" } : {}),
          "persist-credentials": false,
        },
      },
      {
        // shortcut: the stack goes through one environment variable, which Linux caps at 128 KB, far above a plan job and its summary
        env: { STACK: "${{ toJSON(matrix.stack) }}" },
        run: apply ? APPLY : LEVEL,
      },
    ],
  });
  const doc = {
    name: "orch stacks",
    "run-name": "orch ${{ inputs.run_id }} ${{ inputs.action }}",
    on: {
      workflow_dispatch: {
        inputs: {
          run_id: {
            description: "The id of the run on the platform",
            required: true,
            type: "string",
          },
          action: {
            description: "Whether the run plans its stacks or applies the plan that was judged",
            required: false,
            type: "choice",
            options: ["plan", "apply"],
            default: "plan",
          },
        },
      },
    },
    // the identity token is how the run signs in to the platform; nothing else of the repository is asked for
    permissions: { contents: "read", "id-token": "write" },
    jobs: {
      fetch: {
        "runs-on": RUNNER,
        "timeout-minutes": 10,
        outputs: {
          ...Object.fromEntries(levelOutputs.map((o) => [o, `\${{ steps.plan.outputs.${o} }}`])),
          action: "${{ steps.plan.outputs.action }}",
          sha: "${{ steps.plan.outputs.sha }}",
        },
        steps: [
          {
            id: "plan",
            env: {
              RUN_ID: "${{ inputs.run_id }}",
              ACTION: "${{ inputs.action }}",
              ORCH_API_URL: platform.apiUrl,
              ORCH_AUDIENCE: platform.audience,
            },
            run: FETCH,
          },
        ],
      },
      ...Object.fromEntries(levelOutputs.map((_, i) => [`level-${i}`, stackJob(false, i)])),
      ...Object.fromEntries(levelOutputs.map((_, i) => [`apply-${i}`, stackJob(true, i)])),
    },
  };
  return `# Generated by orch: the workflow that runs the stacks of a run. Do not edit: it is the same for every run and reads what to run from the platform.\n${stringify(doc, { version: "1.1", lineWidth: 0, indent: 2, aliasDuplicateObjects: false })}`;
}

const quoted = (s: string) => JSON.stringify(s);

/** The input of an apply on GitHub: what a plan takes, the commit it was judged at, and what was judged of each stack. */
export type GithubApplyInput = Omit<PlanInput, "action"> & {
  action: "apply";
  sha: string;
  judged: Readonly<Record<string, Judged>>;
};

// The line of a GitLab apply job that downloads the plan its plan job saved (an artifact); GitHub has none.
const FETCH_SAVED_PLAN = 'wget -q --header "JOB-TOKEN: $CI_JOB_TOKEN" -O plan.tfplan ';

/**
 * The plan of a run for GitHub (FRG-17's `runPlan`, made for a runner that is not GitLab), or the reasons it cannot run
 * there, all of them in one `GenerateError`, each naming the stack. A stack that says nothing of its state is on the
 * platform's (D9, ADR-0017): GitLab's managed state is not there.
 *
 * Refused, because the jobs would run without what they were asked for or on something they were not asked for:
 * a DNS zone, a cost estimate, a policy set (all three are GitLab jobs), a stack on a worker pool (its tags are GitLab
 * runners'), a stack with an environment (a GitHub job has an environment's claim only by deploying to it; FRG-23),
 * a stack on GitLab's state, and a graph deeper than the file.
 *
 * An apply (FRG-29) has, per stack, the plan job again and an apply job: GitLab's own, less the line that downloads the
 * saved plan, which here is the one the plan job has just written. It carries the commit to check out and what was
 * judged, which the workflow compares with the new plan before it applies anything.
 */
export function githubRunPlan(input: PlanInput | GithubApplyInput): RunPlan {
  const byName = new Map<string, Stack>(input.stacks.map((s) => [s.name, s]));
  const problems: string[] = [];
  if (input.action === "apply" && !new RegExp(SHA).test(input.sha)) {
    problems.push("sha is not a commit: 40 lower-case hexadecimal digits are needed");
  }
  for (const name of [...new Set(input.select)].sort()) {
    const s = byName.get(name);
    if (!s) continue; // the generator names it
    const at = `stack ${quoted(name)}`;
    if (input.action === "apply" && !judgedSchema.safeParse(input.judged[name]).success) {
      problems.push(`${at} has no judged changes to apply`);
    }
    if (s.tool === "dnscontrol")
      problems.push(`${at} is a DNS zone: DNSControl runs on GitLab only`);
    else if (input.cost?.stacks.includes(name)) {
      problems.push(`${at} is cost-gated: the cost estimate runs on GitLab only`);
    }
    if (input.policy && setsFor(s.tags, input.policy.sets).length > 0) {
      problems.push(
        `${at} is judged by policy: its summary job fetches the sets from GitLab with CI_JOB_TOKEN, which GitHub has not`,
      );
    }
    if (resolvePool(s.pool, input.pools ?? []).kind === "pool") {
      problems.push(`${at} is on a worker pool: pools are GitLab runners, and GitHub has none yet`);
    }
    if (s.environment !== undefined) {
      problems.push(
        `${at} reads the variables of environment ${quoted(s.environment)}: a GitHub job has an environment only by deploying to it, which is not built yet`,
      );
    }
    if (s.state === "gitlab") {
      problems.push(`${at} keeps its state in GitLab's managed state, which GitHub does not have`);
    }
  }
  if (problems.length > 0) throw new GenerateError(problems);
  const stacks = input.stacks.map((s) =>
    s.state === undefined ? { ...s, state: "orch" as const } : s,
  );
  const planned = runPlan({ ...input, action: "plan", stacks });
  if (planned.levels.length > STACK_WORKFLOW_LEVELS) {
    throw new GenerateError([
      `the stacks run in ${planned.levels.length} levels; the workflow has room for ${STACK_WORKFLOW_LEVELS}`,
    ]);
  }
  if (input.action !== "apply") return planned;
  const { judged, sha } = input;
  const applied = runPlan({
    ...input,
    stacks,
    // only the line that downloads the saved plan names these (any job id will do), and that line is dropped below
    planJobs: Object.fromEntries(input.select.map((n) => [n, 1])),
    platform: { apiUrl: input.apiUrl, audience: input.audience },
  });
  const applyOf = new Map(applied.levels.flat().map((s) => [s.name, s.jobs.apply]));
  const unfit: string[] = [];
  const levels = planned.levels.map((level) =>
    level.map((s) => {
      const job = applyOf.get(s.name);
      const commands = job?.commands.filter((c) => !c.startsWith(FETCH_SAVED_PLAN));
      if (!job || !commands || commands.length !== job.commands.length - 1) {
        unfit.push(
          `stack ${quoted(s.name)}: its apply job does not download a saved plan, which is the line GitHub drops`,
        );
        return s;
      }
      return {
        ...s,
        jobs: { plan: s.jobs.plan, apply: { ...job, commands } },
        judged: judged[s.name],
      };
    }),
  );
  if (unfit.length > 0) throw new GenerateError(unfit);
  return { action: "apply", sha, levels };
}
