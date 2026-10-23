import { afterEach, describe, expect, test } from "bun:test";
import { GitlabError, type PipelineStatus } from "@orch/gitlab";
import { createGithubClient } from "./client";
import { createMockGithub } from "./mock/server";
import { pipelinesApi, statusOf } from "./pipelines";
import { repoBase } from "./projects";

// FRG-14: a workflow run as the platform's pipeline, a job as its job.

let mock: ReturnType<typeof createMockGithub>;
afterEach(() => mock?.stop());

function setup(opts: Parameters<typeof createMockGithub>[0] = {}) {
  mock?.stop();
  mock = createMockGithub(opts);
  const repo = mock.addRepo("acme", "svc");
  const client = createGithubClient({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    token: "ghp_not-a-real-token-1234",
    maxRetries: 0,
  });
  const { pipelines } = pipelinesApi(client, repoBase(client));
  const calls = () => mock.requests.filter((r) => r.path.includes("/actions/"));
  return { repo, pipelines, calls, ref: "acme/svc" };
}

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("one status from GitHub's status and conclusion", () => {
  const table: [string | null, string | null, PipelineStatus][] = [
    ["requested", null, "created"],
    ["queued", null, "pending"],
    ["pending", null, "waiting_for_resource"],
    ["waiting", null, "manual"],
    ["in_progress", null, "running"],
    ["completed", "success", "success"],
    ["completed", "neutral", "success"],
    ["completed", "failure", "failed"],
    ["completed", "timed_out", "failed"],
    ["completed", "startup_failure", "failed"],
    ["completed", "cancelled", "canceled"],
    ["completed", "stale", "canceled"],
    ["completed", "skipped", "skipped"],
    ["completed", "action_required", "manual"],
    // a word GitHub adds later reads as unknown, and a finished run with no conclusion is not guessed at
    ["completed", "something_new", "unknown"],
    ["completed", null, "unknown"],
    ["something_new", null, "unknown"],
    [null, null, "unknown"],
    // the conclusion only counts once the run is completed
    ["in_progress", "success", "running"],
  ];
  for (const [status, conclusion, want] of table) {
    test(`${status} / ${conclusion} is ${want}`, () => {
      expect(statusOf(status, conclusion)).toBe(want);
    });
  }
});

describe("a run on the GitHub mock", () => {
  test("reads as queued, running, succeeded and failed, with the run's own fields", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", { branch: "feat/x", sha: "a".repeat(40) });

    const seen = async () => (await pipelines.get(ref, run.id)).status;
    expect(await pipelines.get(ref, run.id)).toEqual({
      id: run.id,
      iid: run.number,
      status: "pending",
      ref: "feat/x",
      sha: "a".repeat(40),
      webUrl: expect.stringContaining(`/actions/runs/${run.id}`),
    });
    mock.setRun("acme", "svc", run.id, { status: "in_progress" });
    expect(await seen()).toBe("running");
    mock.setRun("acme", "svc", run.id, { status: "completed", conclusion: "success" });
    expect(await seen()).toBe("success");
    mock.setRun("acme", "svc", run.id, { status: "completed", conclusion: "failure" });
    expect(await seen()).toBe("failed");
  });

  test("a run that GitHub does not show, or another repository's, is not found", async () => {
    const { pipelines, ref } = setup();
    mock.addRepo("acme", "other");
    const elsewhere = mock.addRun("acme", "other", {});
    await expect(pipelines.get(ref, elsewhere.id)).rejects.toMatchObject({ kind: "not_found" });
    await expect(pipelines.get(ref, 2_000_000_000)).rejects.toMatchObject({ kind: "not_found" });
  });

  test("a run number that is not a whole number is refused and nothing is sent", async () => {
    const { pipelines, ref } = setup();
    for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 60]) {
      const e = await pipelines.get(ref, bad).catch((x) => x);
      expect(e).toBeInstanceOf(GitlabError);
      expect(e.kind).toBe("invalid");
    }
    expect(mock.requests).toEqual([]);
  });

  test("the repository may be named by its id", async () => {
    const { pipelines, repo } = setup();
    const run = mock.addRun("acme", "svc", {});
    expect((await pipelines.get(repo.id, run.id)).id).toBe(run.id);
  });

  test("a run with no branch (a tag, a dispatch from nowhere) has an empty ref, not null", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", { branch: null });
    expect((await pipelines.get(ref, run.id)).ref).toBe("");
  });
});

describe("the jobs of a run", () => {
  test("come with GitHub's status mapped, no stage and no allowed failure", async () => {
    const { pipelines, ref, calls } = setup();
    const run = mock.addRun("acme", "svc", {
      status: "completed",
      conclusion: "failure",
      jobs: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure" },
        { name: "deploy", status: "completed", conclusion: "skipped" },
        { name: "lint", status: "in_progress" },
        { name: "later", status: "queued" },
      ],
    });
    const jobs = await collect(pipelines.jobs(ref, run.id));
    expect(jobs.map((j) => [j.name, j.status])).toEqual([
      ["build", "success"],
      ["test", "failed"],
      ["deploy", "skipped"],
      ["lint", "running"],
      ["later", "pending"],
    ]);
    // there are no stages on GitHub (the `stages` flag says so), and a job cannot be allowed to fail
    expect(jobs.every((j) => j.stage === "" && j.allowFailure === false)).toBe(true);
    expect(jobs.every((j) => j.failureReason === null)).toBe(true);
    expect(jobs[0]?.webUrl).toContain("/actions/runs/");
    // the latest attempt of each job, not every attempt
    expect(calls().at(-1)?.query.get("filter")).toBe("latest");
  });

  test("one job of a run can be moved or added on the mock, and keeps its id", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", {
      status: "in_progress",
      jobs: [{ name: "apply:net", status: "queued" }],
    });
    const before = (await collect(pipelines.jobs(ref, run.id)))[0];
    mock.setJob("acme", "svc", run.id, "apply:net", { status: "waiting" });
    mock.setJob("acme", "svc", run.id, "apply:app", { status: "queued" });
    const after = await collect(pipelines.jobs(ref, run.id));
    expect(after.map((j) => [j.name, j.status])).toEqual([
      ["apply:net", "manual"],
      ["apply:app", "pending"],
    ]);
    expect(after[0]?.id).toBe(before?.id);
    expect(() => mock.setJob("acme", "svc", 1, "x", {})).toThrow("no run 1");
  });

  test("a finished job has its times and its duration; one that has not started has none", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", {
      jobs: [
        { name: "done", status: "completed", conclusion: "success" },
        { name: "waiting", status: "queued" },
      ],
    });
    const [done, waiting] = await collect(pipelines.jobs(ref, run.id));
    expect(done?.startedAt).toBeString();
    expect(done?.finishedAt).toBeString();
    expect(done?.duration).toBe(65);
    expect([waiting?.startedAt, waiting?.finishedAt, waiting?.duration]).toEqual([
      null,
      null,
      null,
    ]);
  });

  test("every page is read", async () => {
    const { pipelines, ref } = setup({ maxPerPage: 2 });
    const run = mock.addRun("acme", "svc", {
      jobs: Array.from({ length: 5 }, (_, i) => ({ name: `j${i}` })),
    });
    const jobs = await collect(pipelines.jobs(ref, run.id));
    expect(jobs.map((j) => j.name)).toEqual(["j0", "j1", "j2", "j3", "j4"]);
  });

  test("a run with no jobs has none", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", { jobs: [] });
    expect(await collect(pipelines.jobs(ref, run.id))).toEqual([]);
  });
});

describe("child pipelines", () => {
  test("GitHub has none: bridges is empty and asks GitHub nothing", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", {});
    expect(await collect(pipelines.bridges(ref, run.id))).toEqual([]);
    expect(mock.requests).toEqual([]);
  });
});

describe("retry and cancel", () => {
  test("retry runs the failed jobs again and returns the run as it is then", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", {
      status: "completed",
      conclusion: "failure",
      jobs: [
        { name: "build", status: "completed", conclusion: "success" },
        { name: "test", status: "completed", conclusion: "failure" },
      ],
    });
    const again = await pipelines.retry(ref, run.id);
    expect(again).toMatchObject({ id: run.id, status: "pending" });
    expect(mock.requests.map((r) => `${r.method} ${r.path.split("/runs/")[1]}`)).toContain(
      `POST ${run.id}/rerun-failed-jobs`,
    );
    // the job that passed is kept, the one that failed starts again
    const jobs = await collect(pipelines.jobs(ref, run.id));
    expect(jobs.map((j) => [j.name, j.status])).toEqual([
      ["build", "success"],
      ["test", "pending"],
    ]);
  });

  test("a run that is still going cannot be retried: GitHub's refusal comes through as forbidden", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", { status: "in_progress" });
    await expect(pipelines.retry(ref, run.id)).rejects.toMatchObject({ kind: "forbidden" });
  });

  test("cancel stops a run that is going and returns it", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", { status: "in_progress" });
    const stopped = await pipelines.cancel(ref, run.id);
    expect(stopped).toMatchObject({ id: run.id, status: "canceled" });
    expect(mock.requests.some((r) => r.path.endsWith(`/runs/${run.id}/cancel`))).toBe(true);
  });

  test("a run that has finished cannot be canceled", async () => {
    const { pipelines, ref } = setup();
    const run = mock.addRun("acme", "svc", { status: "completed", conclusion: "success" });
    const e = await pipelines.cancel(ref, run.id).catch((x) => x);
    expect(e).toBeInstanceOf(GitlabError);
    expect(e.kind).not.toBe("unexpected");
  });

  test("a retry or a cancel of a run that is not there is not found", async () => {
    const { pipelines, ref } = setup();
    await expect(pipelines.retry(ref, 2_000_000_000)).rejects.toMatchObject({
      kind: "not_found",
    });
    await expect(pipelines.cancel(ref, 2_000_000_000)).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});
