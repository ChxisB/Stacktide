import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { type ApplyInput, generatePipeline, type PlanInput } from "./pipeline-gen";
import type { PolicySet } from "./policy";
import type { PoolRef } from "./pool";
import { PLAN_JOBS, type RunPlan, runPlan, runPlanSchema } from "./run-plan";
import type { Stack } from "./scan";

// FRG-17: the plan of a run as data, for a runner that is not GitLab. It is read off the very jobs the GitLab
// generator writes, so the two cannot drift.

const stack = (name: string, over: Partial<Stack> = {}): Stack => ({
  name,
  path: `stacks/${name}`,
  tool: "terraform",
  version: "1.9.8",
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "http",
  ...over,
});

// net <- db <- app, net <- queue; one stack on the platform's state, one with an environment, a zone, a pool
const STACKS = [
  stack("app", { dependsOn: ["db"], environment: "prod" }),
  stack("db", { dependsOn: ["net"], state: "orch", backend: "unchecked" }),
  stack("net", { tags: ["prod"] }),
  stack("queue", { dependsOn: ["net"], tool: "tofu", version: "1.8.2", pool: "big" }),
  stack("zone", { tool: "dnscontrol", version: "5.5.0", path: "dns", backend: "unchecked" }),
];
const POOL: PoolRef = {
  name: "big",
  tags: ["big-runner"],
  image: null,
  enabled: true,
  isDefault: false,
};
const SET: PolicySet = {
  name: "prod-rules",
  source: "platform/policies",
  ref: "v1.2.0",
  path: ".",
  tag: "prod",
};
const IMAGES = {
  terraform: "registry.example.com/tf-orch",
  tofu: "registry.example.com/tofu-orch",
};

const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
  action: "plan",
  stacks: STACKS,
  select: ["app", "db", "net", "queue", "zone"],
  audience: "orch.example.com",
  apiUrl: "https://orch.example.com",
  summaryPath: "/runs/0b9e5bd2/plan-summary",
  helperImage: "registry.example.com/orch/ci-helper:1.0.0",
  images: { ...IMAGES, dnscontrol: "registry.example.com/dns-orch" },
  pools: [POOL],
  policy: {
    sets: [SET],
    image: "registry.example.com/orch/ci-policy:1.0.0",
    path: "/runs/0b9e5bd2/policy-verdict",
  },
  cost: { stacks: ["net", "db"], image: "registry.example.com/orch/ci-cost:1.0.0" },
  cloudTokens: { AWS_ID_TOKEN: "sts.amazonaws.com" },
  ...over,
});

const apply = (over: Partial<ApplyInput> = {}): ApplyInput => ({
  action: "apply",
  stacks: STACKS,
  select: ["app", "db", "net", "queue", "zone"],
  planJobs: { app: 104, db: 103, net: 101, queue: 102, zone: 105 },
  images: { ...IMAGES, dnscontrol: "registry.example.com/dns-orch" },
  pools: [POOL],
  platform: { apiUrl: "https://orch.example.com", audience: "orch.example.com" },
  ...over,
});

// biome-ignore lint/suspicious/noExplicitAny: a job read back from YAML, looked into loosely by the tests
type Job = Record<string, any>;
const gitlabJobs = (input: PlanInput | ApplyInput): Record<string, Job> => {
  const { stages: _, ...jobs } = parse(generatePipeline(input));
  return jobs;
};
const stacksOf = (p: RunPlan) => p.levels.flat();

describe.each([
  ["a plan", plan()],
  ["a plan of one stack", plan({ select: ["net"] })],
  ["a plan of the middle of the graph", plan({ select: ["db", "app"] })],
  ["an apply", apply()],
  ["an apply of one stack", apply({ select: ["queue"] })],
])("the plan data of %s", (_, input) => {
  const data = runPlan(input);
  const jobs = gitlabJobs(input);

  test("every command, image, runner tag, variable and token is the GitLab job's own", () => {
    for (const s of stacksOf(data)) {
      for (const [kind, job] of Object.entries(s.jobs)) {
        const theirs = jobs[`${kind}:${s.name}`] as Job;
        expect(theirs, `${kind}:${s.name}`).toBeDefined();
        expect(job.commands).toEqual(theirs.script);
        expect(job.image).toBe(theirs.image.name);
        expect(job.tags).toEqual(theirs.tags ?? []);
        expect(job.env).toEqual(theirs.variables ?? {});
        expect(job.idTokens).toEqual(
          Object.fromEntries(
            Object.entries((theirs.id_tokens ?? {}) as Record<string, { aud: string }>).map(
              ([n, t]) => [n, t.aud],
            ),
          ),
        );
        expect(job.allowFailure).toBe(theirs.allow_failure === true);
      }
    }
  });

  test("and every job of the pipeline is there, but the manual import extra", () => {
    const ours = new Set(
      stacksOf(data).flatMap((s) => Object.keys(s.jobs).map((kind) => `${kind}:${s.name}`)),
    );
    const theirs = Object.keys(jobs).filter((n) => PLAN_JOBS.includes(n.split(":")[0] as never));
    expect([...ours].sort()).toEqual(theirs.sort());
  });

  test("the levels are the waves (the stage of the job) and each stack needs the stacks it waits for", () => {
    const action = input.action;
    data.levels.forEach((level, i) => {
      for (const s of level) {
        const theirs = jobs[`${action}:${s.name}`] as Job;
        expect(theirs.stage).toBe(`wave-${i}`);
        expect(s.needs).toEqual(
          theirs.needs.map((n: { job: string }) => n.job.slice(`${action}:`.length)),
        );
      }
    });
    expect(
      stacksOf(data)
        .map((s) => s.name)
        .sort(),
    ).toEqual([...input.select].sort());
  });

  test("it is the shape the route promises, and survives being sent as JSON", () => {
    expect(runPlanSchema.parse(JSON.parse(JSON.stringify(data)))).toEqual(data);
  });
});

describe("what the data says of a stack", () => {
  const byName = (p: RunPlan) => new Map(stacksOf(p).map((s) => [s.name, s]));
  const data = byName(runPlan(plan()));

  test("its place, tool, version, environment and the mode of its state", () => {
    expect(data.get("app")).toMatchObject({
      path: "stacks/app",
      tool: "terraform",
      version: "1.9.8",
      environment: "prod",
      state: "gitlab",
      needs: ["db"],
    });
    expect(data.get("net")).toMatchObject({ environment: null, state: "gitlab", needs: [] });
    expect(data.get("db")).toMatchObject({ state: "orch" });
    // a zone keeps no Terraform state, and a stack with a backend of its own is left on it
    expect(data.get("zone")).toMatchObject({ tool: "dnscontrol", state: "none" });
    const own = byName(
      runPlan(plan({ stacks: [stack("s", { backend: "other" })], select: ["s"], pools: [] })),
    );
    expect(own.get("s")).toMatchObject({ state: "own" });
  });

  test("the levels hold the stacks that can run together, in the order they must", () => {
    expect(runPlan(plan()).levels.map((l) => l.map((s) => s.name))).toEqual([
      ["net", "zone"],
      ["db", "queue"],
      ["app"],
    ]);
  });

  test("a stack on a pool asks for its runners; a stack on platform state signs in", () => {
    expect(data.get("queue")?.jobs.plan?.tags).toEqual(["big-runner"]);
    expect(data.get("db")?.jobs.plan?.commands.join("\n")).toContain("orch ci login --state");
    expect(data.get("db")?.jobs.plan?.idTokens).toEqual({
      AWS_ID_TOKEN: "sts.amazonaws.com",
      ORCH_ID_TOKEN: "orch.example.com",
    });
  });

  test("the estimate of a costed stack is optional, and its summary holds the platform's token", () => {
    expect(data.get("net")?.jobs.estimate?.allowFailure).toBe(true);
    expect(data.get("net")?.jobs.plan?.allowFailure).toBe(false);
    expect(data.get("queue")?.jobs.estimate).toBeUndefined();
    expect(data.get("net")?.jobs.summary?.idTokens).toEqual({ ORCH_ID_TOKEN: "orch.example.com" });
  });

  test("an apply has an apply job and no summary", () => {
    const a = byName(runPlan(apply()));
    expect(Object.keys(a.get("net")?.jobs ?? {})).toEqual(["apply"]);
  });
});

describe("what the data does not hold", () => {
  test("a variable is named, never given a value: the tokens are references the runner resolves", () => {
    const text = JSON.stringify(runPlan(plan()));
    // the platform's token, the job's own and the state password are all `$NAME`s
    expect(text).toContain("$ORCH_TOKEN");
    expect(text).toContain('TF_HTTP_PASSWORD=\\"$ORCH_STATE_TOKEN\\"');
    expect(text).toContain('"TF_HTTP_PASSWORD":"$CI_JOB_TOKEN"');
    // and the environment's variables reach a tool by prefix, not by value
    expect(text).not.toMatch(/TF_VAR_[A-Za-z0-9_]+=/);
  });

  test("a request the generator refuses is refused here, with its problems", () => {
    expect(() => runPlan(plan({ select: ["nope"] }))).toThrow(/unknown stack/);
    expect(() => runPlan(plan({ select: [] }))).toThrow(/no stack was selected/);
  });
});
