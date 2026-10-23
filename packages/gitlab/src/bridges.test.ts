import { describe, expect, test } from "bun:test";
import type { GitlabClient } from "./client";
import { createGitlab, GitlabError } from "./index";
import { createMockGitlab } from "./mock/server";
import { pipelinesApi } from "./pipelines";

// NOD-5: a trigger job knows its stage, its page and the pipeline it started, in this project or another.

const CI = "build:\n  stage: build\n  script:\n    - make\n";
const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

function ready() {
  const mock = createMockGitlab();
  const web = mock.addProject({ path: "g/web", files: { ".gitlab-ci.yml": CI } });
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  return { mock, api, web };
}

/** The parser on a payload the mock would never send: what a real GitLab adds, and what an old one leaves out. */
const bridgesOf = (...raw: unknown[]) =>
  collect(
    pipelinesApi({
      paginate: async function* () {
        yield* raw;
      },
    } as unknown as GitlabClient).pipelines.bridges("g/web", 1),
  );

describe("a trigger job (bridge)", () => {
  test("one that started a pipeline in the same project says which", async () => {
    const { mock, api, web } = ready();
    const parent = await api.pipelines.trigger("g/web", "main");
    const child = mock.addDownstream(parent.id, "deploy", ["a", "b"], { stage: "deploy" });
    expect(await collect(api.pipelines.bridges("g/web", parent.id))).toEqual([
      {
        id: expect.any(Number),
        name: "deploy",
        stage: "deploy",
        status: "pending",
        webUrl: expect.stringContaining(`${mock.url}/g/web/-/jobs/`),
        downstreamPipelineId: child,
        downstream: {
          pipelineId: child,
          projectId: web.id,
          status: "pending",
          webUrl: `${mock.url}/g/web/-/pipelines/${child}`,
        },
      },
    ]);
    mock.stop();
  });

  test("one that started a pipeline in another project says that project's number, and its jobs are not reachable through this one", async () => {
    const { mock, api, web } = ready();
    const other = mock.addProject({ path: "g/api" });
    const parent = await api.pipelines.trigger("g/web", "main");
    const child = mock.addDownstream(parent.id, "deploy", ["migrate"], { project: "g/api" });
    const [b] = await collect(api.pipelines.bridges("g/web", parent.id));
    expect(b?.downstreamPipelineId).toBe(child);
    expect(b?.downstream).toEqual({
      pipelineId: child,
      projectId: other.id,
      status: "pending",
      webUrl: `${mock.url}/g/api/-/pipelines/${child}`,
    });
    expect(b?.downstream?.projectId).not.toBe(web.id);
    // a pipeline is read through its own project, as on GitLab
    await expect(collect(api.pipelines.jobs("g/web", child))).rejects.toBeInstanceOf(GitlabError);
    expect((await collect(api.pipelines.jobs("g/api", child))).map((j) => j.name)).toEqual([
      "migrate",
    ]);
    mock.stop();
  });

  test("one that has not started anything has no downstream", async () => {
    const { mock, api } = ready();
    const parent = await api.pipelines.trigger("g/web", "main");
    mock.addBridge(parent.id, "deploy", "deploy");
    const [b] = await collect(api.pipelines.bridges("g/web", parent.id));
    expect([b?.name, b?.stage, b?.downstreamPipelineId, b?.downstream]).toEqual([
      "deploy",
      "deploy",
      null,
      null,
    ]);
    mock.stop();
  });

  test("keeps only the fields it names", async () => {
    const [b] = await bridgesOf({
      id: 7,
      name: "deploy",
      stage: "deploy",
      status: "running",
      web_url: "https://gitlab.example/g/web/-/jobs/7",
      user: { username: "ada", email: "ada@example.com" },
      commit: { id: "abc", message: "secret plans" },
      pipeline: { id: 1 },
      downstream_pipeline: {
        id: 5,
        iid: 2,
        project_id: 9,
        status: "running",
        web_url: "https://gitlab.example/g/api/-/pipelines/5",
        sha: "abc",
        source: "pipeline",
        user: { username: "ada" },
      },
    });
    expect(b).toEqual({
      id: 7,
      name: "deploy",
      stage: "deploy",
      status: "running",
      webUrl: "https://gitlab.example/g/web/-/jobs/7",
      downstreamPipelineId: 5,
      downstream: {
        pipelineId: 5,
        projectId: 9,
        status: "running",
        webUrl: "https://gitlab.example/g/api/-/pipelines/5",
      },
    });
  });

  test("a GitLab that leaves fields out still reads, and one that adds a status reads as unknown", async () => {
    const [bare, newer] = await bridgesOf(
      { id: 1, name: "deploy", status: "success", downstream_pipeline: { id: 5 } },
      {
        id: 2,
        name: "later",
        status: "success",
        downstream_pipeline: { id: 6, project_id: 9, status: "invented_later" },
      },
    );
    expect(bare).toEqual({
      id: 1,
      name: "deploy",
      stage: "",
      status: "success",
      webUrl: "",
      downstreamPipelineId: 5,
      downstream: { pipelineId: 5, projectId: null, status: null, webUrl: "" },
    });
    expect(newer?.downstream?.status).toBe("unknown");
  });
});
