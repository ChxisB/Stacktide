import { describe, expect, test } from "bun:test";
import { createGitlab } from "./index";
import { createMockGitlab } from "./mock/server";

// FLW-7: a job says when it started and finished and how long it took, so a page can show a duration.

const CI =
  "build:\n  stage: build\n  script:\n    - make\ntest:\n  stage: test\n  script:\n    - make test\n";
const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};
const times = (j: {
  startedAt: string | null;
  finishedAt: string | null;
  duration: number | null;
}) => [j.startedAt, j.finishedAt, j.duration] as const;

function ready() {
  const mock = createMockGitlab();
  mock.addProject({ path: "g/p", files: { ".gitlab-ci.yml": CI } });
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  return { mock, api };
}

describe("a job's times", () => {
  test("a job nobody has run has none, a finished one has all three, a retried one has none again", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main");
    const jobs = async () => collect(api.pipelines.jobs("g/p", p.id));
    expect((await jobs()).map(times)).toEqual([
      [null, null, null],
      [null, null, null],
    ]);

    mock.finishPipeline(p.id, "failed");
    for (const j of await jobs()) {
      expect(typeof j.startedAt).toBe("string");
      expect(typeof j.finishedAt).toBe("string");
      expect(new Date(j.startedAt as string).toISOString()).toBe(j.startedAt as string);
      expect(new Date(j.finishedAt as string).getTime()).toBeGreaterThanOrEqual(
        new Date(j.startedAt as string).getTime(),
      );
      expect(j.duration).toBeGreaterThanOrEqual(0);
    }

    await api.pipelines.retry("g/p", p.id);
    expect((await jobs()).map(times)).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
    mock.stop();
  });

  test("a running job has started and not finished", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main");
    mock.setJobStatus(p.id, "build", "running");
    const [build, test_] = await collect(api.pipelines.jobs("g/p", p.id));
    expect(typeof build?.startedAt).toBe("string");
    expect([build?.finishedAt, build?.duration]).toEqual([null, null]);
    expect(test_ && times(test_)).toEqual([null, null, null]);
    mock.stop();
  });

  test("what GitLab sends that the parser does not name is not carried, and a missing time is null", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json([
          {
            id: 7,
            name: "deploy",
            stage: "deploy",
            status: "success",
            web_url: "https://gitlab.example/g/p/-/jobs/7",
            started_at: "2026-10-20T10:00:00.000Z",
            finished_at: "2026-10-20T10:01:12.500Z",
            duration: 72.5,
            // none of these is named by the parser
            trace: "$ echo super-secret-value",
            runner: { id: 1, description: "shared" },
            user: { id: 2, username: "someone" },
            artifacts_file: { filename: "a.zip" },
          },
          {
            id: 8,
            name: "old",
            stage: "deploy",
            status: "pending",
            web_url: "https://gitlab.example/g/p/-/jobs/8",
          },
        ]),
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    const [done, old] = await collect(api.pipelines.jobs("g/p", 1));
    expect(done).toEqual({
      id: 7,
      name: "deploy",
      stage: "deploy",
      status: "success",
      allowFailure: false,
      failureReason: null,
      webUrl: "https://gitlab.example/g/p/-/jobs/7",
      startedAt: "2026-10-20T10:00:00.000Z",
      finishedAt: "2026-10-20T10:01:12.500Z",
      duration: 72.5,
    });
    expect(old && times(old)).toEqual([null, null, null]);
    server.stop(true);
  });
});
