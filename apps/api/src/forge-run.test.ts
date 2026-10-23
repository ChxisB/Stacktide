import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DomainError } from "@orch/core";
import { createOrganization, createProject, createRun, getRunPlan } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { githubForge, gitlabForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import {
  APPLY_ENVIRONMENT,
  type GithubApplyInput,
  githubRunPlan,
  type PlanInput,
  renderStackWorkflow,
  STACK_WORKFLOW_FILE,
  type Stack,
  stackRunName,
} from "@orch/iac";
import { startForgeRun } from "./forge-run";

// FRG-30: a run on GitHub is started by a dispatch of the static workflow. The platform keeps the run's plan where the
// workflow reads it, asks for an apply only behind a gate, and finds the run it started by its name. The workflow
// here is the one the platform writes, so what it declares and what the platform sends are checked against each other.

let t: TestDb;
let mock: ReturnType<typeof createMockGithub>;
const ids = {} as Record<"org" | "project" | "run", string>;

beforeAll(async () => {
  t = await createTestDb();
  ids.org = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  ids.project = (await createProject(t.db, { organizationId: ids.org, name: "svc" })).id;
});
afterAll(async () => {
  await t.drop();
});
afterEach(() => mock?.stop());

const PLATFORM = { apiUrl: "https://orch.example.com", audience: "orch.example.com" };
const SHA = "0123456789abcdef0123456789abcdef01234567";

const stack = (name: string, over: Partial<Stack> = {}): Stack => ({
  name,
  path: `stacks/${name}`,
  tool: "tofu",
  version: "1.9.8",
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "http",
  ...over,
});
const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
  action: "plan",
  stacks: [stack("net"), stack("app", { dependsOn: ["net"] })],
  select: ["net", "app"],
  ...PLATFORM,
  summaryPath: "/runs/r/plan-summary",
  helperImage: "registry.example.com/orch/ci-helper:1.0.0",
  images: { tofu: "registry.example.com/tofu-orch" },
  ...over,
});
const apply = (over: Partial<GithubApplyInput> = {}): GithubApplyInput => {
  const { action: _, ...rest } = plan();
  return {
    ...rest,
    action: "apply",
    sha: SHA,
    judged: Object.fromEntries(
      ["net", "app"].map((n) => [
        n,
        { add: 1, change: 0, destroy: 0, resources: [{ address: `x.${n}`, actions: ["create"] }] },
      ]),
    ),
    ...over,
  };
};

const reviewers = {
  id: 1,
  type: "required_reviewers",
  reviewers: [{ type: "User", reviewer: { id: 9 } }],
};

async function setup(opts: { gated?: boolean } = {}) {
  mock = createMockGithub();
  mock.addRepo("acme", "svc", {
    files: { "README.md": "x", [STACK_WORKFLOW_FILE]: renderStackWorkflow(PLATFORM) },
  });
  if (opts.gated) mock.addEnvironment("acme", "svc", APPLY_ENVIRONMENT, [reviewers]);
  const forge = githubForge(
    createGithubClient({
      baseUrl: mock.url,
      allowInsecureHttp: true,
      token: "ghp_not-a-real-token-1234",
      maxRetries: 0,
    }),
    { attempts: 3, delayMs: 0 },
  );
  ids.run = (
    await createRun(t.db, {
      organizationId: ids.org,
      projectId: ids.project,
      ref: "main",
      sha: SHA,
      stacks: ["net", "app"],
    })
  ).id;
  const start = (input: PlanInput | GithubApplyInput, over: { runId?: string } = {}) =>
    startForgeRun(
      { db: t.db, forge },
      {
        organizationId: ids.org,
        projectId: ids.project,
        project: "acme/svc",
        runId: over.runId ?? ids.run,
        ref: "main",
        input,
      },
    );
  const dispatches = () =>
    mock.requests.filter((r) => r.method === "POST" && r.path.endsWith("/dispatches"));
  const titles = async () =>
    (
      (await (
        await fetch(`${mock.url}/api/v3/repos/acme/svc/actions/workflows/orch-stacks.yml/runs`, {
          headers: {
            authorization: "Bearer ghp_not-a-real-token-1234",
            "x-github-api-version": "2022-11-28",
            "user-agent": "t",
            accept: "application/json",
          },
        })
      ).json()) as { workflow_runs: { id: number; display_title: string }[] }
    ).workflow_runs;
  return { forge, start, dispatches, titles };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a failure");
};

describe("a plan", () => {
  test("is kept for the workflow to read, and started by a dispatch that the workflow accepts", async () => {
    const { start, dispatches, titles } = await setup();
    const p = await start(plan());
    // the plan is stored as the workflow's own `githubRunPlan` makes it
    expect(await getRunPlan(t.db, ids.org, ids.project, ids.run, "plan")).toEqual(
      JSON.parse(JSON.stringify(githubRunPlan(plan()))),
    );
    // the dispatch carries the run and the action, and nothing of the run's plan or its values
    expect(dispatches().map((d) => d.body)).toEqual([
      { ref: "main", inputs: { run_id: ids.run, action: "plan" } },
    ]);
    // the run that was found is the one the dispatch made, by the name the file gives it
    const made = (await titles()).find((r) => r.id === p.id);
    expect(made?.display_title).toBe(stackRunName(ids.run, "plan"));
    expect(p.status).toBe("pending");
  });

  test("that GitHub cannot run is refused with the reasons, and nothing is kept or sent", async () => {
    const { start, dispatches } = await setup();
    const e = await failure(
      start(plan({ stacks: [stack("net", { environment: "prod" })], select: ["net"] })),
    );
    expect(e).toMatchObject({ code: "cannot_generate", status: 422 });
    expect((e as Error).message).toContain('stack "net"');
    expect(await getRunPlan(t.db, ids.org, ids.project, ids.run, "plan")).toBeUndefined();
    expect(dispatches()).toEqual([]);
  });

  test("an error that is not the generator's refusal is not dressed up as one", async () => {
    const { start, dispatches } = await setup();
    const input = plan();
    Object.defineProperty(input, "stacks", {
      get() {
        throw new Error("boom");
      },
    });
    expect((await failure(start(input))) as Error).toMatchObject({ message: "boom" });
    expect(dispatches()).toEqual([]);
  });

  test("a dispatch GitHub refuses leaves no run, and the error is GitHub's", async () => {
    const { start } = await setup();
    // the file is not in the repository at that ref
    const e = await failure(
      startForgeRun(
        {
          db: t.db,
          forge: githubForge(
            createGithubClient({
              baseUrl: mock.url,
              allowInsecureHttp: true,
              token: "ghp_not-a-real-token-1234",
              maxRetries: 0,
            }),
            { attempts: 1, delayMs: 0 },
          ),
        },
        {
          organizationId: ids.org,
          projectId: ids.project,
          project: "acme/svc",
          runId: ids.run,
          ref: "no-such-branch",
          input: plan(),
        },
      ),
    );
    expect(e).toMatchObject({ kind: "invalid" });
    void start;
  });
});

describe("an apply", () => {
  test("behind an environment with required reviewers is kept with the commit and what was judged, and started", async () => {
    const { start, dispatches, titles } = await setup({ gated: true });
    const p = await start(apply());
    const kept = (await getRunPlan(t.db, ids.org, ids.project, ids.run, "apply")) as {
      sha: string;
      levels: { name: string; judged: unknown }[][];
    };
    expect(kept.sha).toBe(SHA);
    expect(kept.levels.flat().map((s) => s.name)).toEqual(["net", "app"]);
    expect(dispatches().map((d) => (d.body as { inputs: unknown }).inputs)).toEqual([
      { run_id: ids.run, action: "apply" },
    ]);
    expect((await titles()).find((r) => r.id === p.id)?.display_title).toBe(
      stackRunName(ids.run, "apply"),
    );
  });

  test("with no reviewers on the environment is refused before anything is kept or sent", async () => {
    const { start, dispatches } = await setup();
    mock.addEnvironment("acme", "svc", APPLY_ENVIRONMENT, []);
    const e = await failure(start(apply()));
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toMatchObject({ code: "apply_not_gated", status: 409 });
    expect(await getRunPlan(t.db, ids.org, ids.project, ids.run, "apply")).toBeUndefined();
    expect(dispatches()).toEqual([]);
  });

  test("when the environment cannot be read is refused, not let through", async () => {
    const { start, dispatches } = await setup();
    mock.stop();
    const e = await failure(start(apply()));
    expect(e).toBeTruthy();
    expect(dispatches()).toEqual([]);
  });
});

test("a forge that starts a pipeline with a generated file has no run to start this way", async () => {
  await setup();
  const e = await failure(
    startForgeRun(
      { db: t.db, forge: gitlabForge({} as never) },
      {
        organizationId: ids.org,
        projectId: ids.project,
        project: "acme/svc",
        runId: ids.run,
        ref: "main",
        input: plan(),
      },
    ),
  );
  expect(e).toMatchObject({ code: "forge_cannot_dispatch", status: 422 });
  expect(await getRunPlan(t.db, ids.org, ids.project, ids.run, "plan")).toBeUndefined();
});
