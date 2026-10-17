import { stringify } from "yaml";
import { buildGraph } from "./graph";
import { type Stack, safeDir } from "./scan";
import { NAME, type Tool, VERSION } from "./stack";

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
}

export interface ApplyInput extends Common {
  action: "apply";
  /** The GitLab job that saved each stack's plan. */
  planJobs: Readonly<Record<string, number>>;
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
const API_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~-]+)*$/;
const PATH = /^(?:\/[A-Za-z0-9._~-]+)+$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;
const AUDIENCE = /^[\x21-\x7e]{1,255}$/;

const EXPIRE_IN = "1 week";
// GitLab's limit on `needs` entries per job.
const MAX_NEEDS = 50;
// shortcut: the plan wait for the state lock is fixed; upgrade when a stack needs another one.
const LOCK_TIMEOUT = "5m";
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

// names that come from a user are shown quoted and cut short
const quoted = (s: string) => JSON.stringify(s.length > 64 ? `${s.slice(0, 64)}…` : s);
const inDir = (dir: string, file: string) => (dir === "." ? file : `${dir}/${file}`);

/**
 * The YAML of a child pipeline: one job per selected stack, in stages by wave, each waiting for the
 * selected stacks it depends on (through stacks that are not selected too), in the stack's own
 * `resource_group` so that two runs never touch a stack together.
 *
 * - `plan` saves the plan and its JSON as artifacts and, in a later job that holds the platform's
 *   `id_token` and nothing of the cloud's, posts the counts to the platform.
 * - `apply` fetches the plan the given job saved and applies exactly that.
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

  const built = buildGraph(input.stacks.map((s) => ({ name: s.name, dependsOn: s.dependsOn })));
  if (!built.ok) problems.push(...built.errors.map((e) => e.message));

  if (select.length === 0) problems.push("no stack was selected");
  const repoOf = new Map<string, string>();
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
    const repo = input.images?.[s.tool] ?? IMAGES[s.tool];
    if (repo === undefined) {
      problems.push(`${at} uses ${s.tool}, which needs an image: pass images.${s.tool}`);
    } else repoOf.set(name, repo);
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
  const tokens = cloud.length
    ? { id_tokens: Object.fromEntries(cloud.map((name) => [name, { aud: cloudTokens[name] }])) }
    : {};
  const toolJob = (name: string, script: string[], extra: object) => {
    const s = byName.get(name) as Stack;
    return {
      stage: stageOf.get(name),
      image: { name: `${repoOf.get(name)}:${s.version}`, entrypoint: [""] },
      resource_group: `stack-${name}`,
      needs: needsOf(name).map((n) => ({ job: `${action}:${n}`, artifacts: false })),
      ...tokens,
      ...extra,
      script: s.path === "." ? script : [`cd ${s.path}`, ...script],
    };
  };

  const jobs: Record<string, unknown> = {};
  for (const name of waves.flat()) {
    const { path: dir, tool } = byName.get(name) as Stack;
    if (input.action === "plan") {
      jobs[`plan:${name}`] = toolJob(
        name,
        [
          `${tool} init -input=false`,
          `${tool} plan -input=false -lock-timeout=${LOCK_TIMEOUT} -out=plan.tfplan`,
          `${tool} show -json plan.tfplan > plan.json`,
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
      jobs[`summary:${name}`] = {
        stage: "summary",
        image: { name: input.helperImage, entrypoint: [""] },
        needs: [{ job: `plan:${name}`, artifacts: true }],
        id_tokens: { ORCH_ID_TOKEN: { aud: input.audience } },
        variables: { ORCH_API_URL: input.apiUrl },
        script: [
          'login="$(orch ci login)"',
          'eval "$login"',
          `jq -c --arg stack ${name} '${SUMMARY_FILTER}' ${inDir(dir, "plan.json")} > summary.json`,
          `curl --fail --silent --show-error --request POST --header "Authorization: Bearer $ORCH_TOKEN" --header "Content-Type: application/json" --data @summary.json "$ORCH_API_URL${input.summaryPath}"`,
        ],
      };
    } else {
      jobs[`apply:${name}`] = toolJob(
        name,
        [
          `wget -q --header "JOB-TOKEN: $CI_JOB_TOKEN" -O plan.tfplan "$CI_API_V4_URL/projects/$CI_PROJECT_ID/jobs/${input.planJobs[name]}/artifacts/${inDir(dir, "plan.tfplan")}"`,
          `${tool} init -input=false`,
          `${tool} apply -input=false -lock-timeout=${LOCK_TIMEOUT} plan.tfplan`,
        ],
        {},
      );
    }
  }

  const stages = [...waves.map((_, i) => `wave-${i}`), ...(action === "plan" ? ["summary"] : [])];
  return `# Generated by orch: a child pipeline for ${action} of ${select.length} stack${select.length === 1 ? "" : "s"}. Do not edit.\n${stringify({ stages, ...jobs }, { lineWidth: 0 })}`;
}
