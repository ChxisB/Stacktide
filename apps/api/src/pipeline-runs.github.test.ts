import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, DomainError } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createConnection,
  createOrganization,
  createProject,
  listPipelineRuns,
  recordPipelineRun,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { githubForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { pipelineEventHandler, readPipeline, retryPipeline } from "./pipeline-runs";
import { readJobs } from "./routes/pipeline-runs";
import { readPipeline as readRunPipeline } from "./run-ingest";
import type { JobContext } from "./worker";

// FRG-14: the callers that read, retry and judge a run take a forge, so a run on GitHub reads the way a pipeline does.
// No event or route reaches them with a GitHub connection yet (FRG-21, FRG-22); the GitLab tests did not change.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGithub>;
beforeAll(async () => {
  t = await createTestDb();
});
afterEach(() => mock?.stop());
afterAll(async () => {
  await t.drop();
});

let n = 0;
async function world() {
  mock?.stop();
  mock = createMockGithub();
  const repo = mock.addRepo("acme", `svc${++n}`);
  const forge = githubForge(
    createGithubClient({ baseUrl: mock.url, token: "ghp_not-a-real-token-1234", maxRetries: 0 }),
  );
  const org = await createOrganization(t.db, { slug: `ghr${n}`, name: "O" });
  const connection = await createConnection(t.db, keys, {
    organizationId: org.id,
    type: "github",
    name: "hub",
    config: { baseUrl: mock.url },
    token: "ghp_not-a-real-token-1234",
  });
  const project = await createProject(t.db, {
    organizationId: org.id,
    name: `svc${n}`,
    gitlabProjectId: repo.id,
    connectionId: connection.id,
  });
  const at = {
    organizationId: org.id,
    projectId: project.id,
    gitlabProjectId: repo.id,
    connectionId: connection.id,
  };
  const deps = { db: t.db, gitlab: async () => forge };
  return { repo, forge, org, project, connection, at, deps, name: `svc${n}` };
}

describe("a run on GitHub, read as a pipeline", () => {
  test("reads as queued, running, succeeded and failed, and the row is stored", async () => {
    const w = await world();
    const run = mock.addRun("acme", w.name, { branch: "feat/x", jobs: [{ name: "build" }] });
    const read = () => readPipeline(w.deps, w.at, run.id);

    expect(await read()).toMatchObject({
      status: "pending",
      gitlabPipelineId: run.id,
      iid: run.number,
      ref: "feat/x",
      failedJob: null,
      failureReason: null,
    });
    mock.setRun("acme", w.name, run.id, { status: "in_progress" });
    expect((await read()).status).toBe("running");
    mock.setRun("acme", w.name, run.id, { status: "completed", conclusion: "success" });
    expect((await read()).status).toBe("success");

    const failed = mock.addRun("acme", w.name, {
      status: "completed",
      conclusion: "failure",
      jobs: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure" },
        { name: "lint", status: "completed", conclusion: "failure" },
      ],
    });
    const row = await readPipeline(w.deps, w.at, failed.id);
    // the first job that failed, the way a GitLab pipeline names it; GitHub gives no reason of its own
    expect(row).toMatchObject({ status: "failed", failedJob: "test", failureReason: null });

    // and it fits the table the GitLab runs are in
    await recordPipelineRun(t.db, row);
    const stored = await listPipelineRuns(t.db, w.org.id, w.project.id, { limit: 10 });
    expect(stored.map((r) => [r.gitlabPipelineId, r.status])).toEqual([[failed.id, "failed"]]);
  });

  test("the jobs and the child pipelines a run's events are judged by: jobs, and no children", async () => {
    const w = await world();
    const run = mock.addRun("acme", w.name, {
      status: "in_progress",
      jobs: [
        { name: "plan:net", status: "completed", conclusion: "success" },
        { name: "apply:net", status: "in_progress" },
      ],
    });
    const seen = await readRunPipeline(w.forge, w.repo.id, run.id);
    expect(seen.status).toBe("running");
    expect(seen.jobs.map((j) => [j.name, j.status])).toEqual([
      ["plan:net", "success"],
      ["apply:net", "running"],
    ]);
    expect(mock.requests.filter((r) => r.path.endsWith("/bridges"))).toEqual([]);
  });

  test("the jobs of the runs page come oldest first and stop at the limit", async () => {
    const w = await world();
    const run = mock.addRun("acme", w.name, {
      jobs: ["a", "b", "c", "d"].map((name) => ({ name })),
    });
    const all = await readJobs(w.forge, w.repo.id, run.id, 10);
    expect(all.jobs.map((j) => j.name)).toEqual(["a", "b", "c", "d"]);
    expect(all.truncated).toBe(false);
    const cut = await readJobs(w.forge, w.repo.id, run.id, 3);
    expect(cut.jobs).toHaveLength(3);
    expect(cut.truncated).toBe(true);
  });

  test("a retry runs the failed jobs again and reads the run after it", async () => {
    const w = await world();
    const run = mock.addRun("acme", w.name, { status: "completed", conclusion: "failure" });
    const row = await retryPipeline(w.deps, w.at, run.id);
    expect(row).toMatchObject({ gitlabPipelineId: run.id, status: "pending" });
    expect(mock.requests.some((r) => r.path.endsWith(`/runs/${run.id}/rerun-failed-jobs`))).toBe(
      true,
    );
  });

  test("a run that is still going is refused its retry as a refusal, not as a failure of GitHub", async () => {
    const w = await world();
    const run = mock.addRun("acme", w.name, { status: "in_progress" });
    const e = await retryPipeline(w.deps, w.at, run.id).catch((x) => x);
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toMatchObject({ code: "gitlab_refused", status: 422 });
  });

  test("a run GitHub no longer has reads as gone", async () => {
    const w = await world();
    const e = await retryPipeline(w.deps, w.at, 2_000_000_000).catch((x) => x);
    expect(e).toMatchObject({ code: "gitlab_pipeline_gone", status: 422 });
  });
});

describe("an event of GitLab's, and a repository of GitHub's with the same number", () => {
  test("a GitLab pipeline event is not about the GitHub repository whose id it shares (FRG-15)", async () => {
    const w = await world();
    const asked: unknown[] = [];
    const handler = pipelineEventHandler({
      db: t.db,
      gitlab: async (...args) => {
        asked.push(args);
        throw new Error("the connection must not be opened");
      },
    });
    const ctx: JobContext = {
      id: "job",
      queue: WEBHOOK_QUEUE,
      payload: {
        event: "pipeline",
        organizationId: w.org.id,
        connectionId: w.connection.id,
        projectId: w.repo.id,
        pipelineId: 1,
      },
      attempt: 1,
      maxAttempts: 5,
      log: createLogger({ level: "debug", write: () => {} }),
      signal: new AbortController().signal,
    };
    await handler(ctx);
    // dropped as an event for a project that is not linked: nothing was opened, read or stored
    expect(asked).toEqual([]);
    expect(mock.requests).toEqual([]);
    expect(await listPipelineRuns(t.db, w.org.id, w.project.id, { limit: 10 })).toEqual([]);
  });
});
