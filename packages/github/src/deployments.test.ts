import { afterEach, describe, expect, test } from "bun:test";
import type { DeploymentStatus, GitlabError } from "@orch/gitlab";
import { createGithubClient } from "./client";
import { deploymentStatusOf, deploymentsApi } from "./deployments";
import { createMockGithub } from "./mock/server";
import { repoBase } from "./projects";

// CLD-10: a deployment and its newest status as the platform's deployment, an environment as its environment.

let mock: ReturnType<typeof createMockGithub>;
afterEach(() => mock?.stop());

function setup(opts: Parameters<typeof createMockGithub>[0] = {}) {
  mock?.stop();
  mock = createMockGithub(opts);
  mock.addRepo("acme", "svc");
  const client = createGithubClient({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    token: "ghp_not-a-real-token-1234",
    maxRetries: 0,
  });
  return { ...deploymentsApi(client, repoBase(client)), project: "acme/svc" };
}

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as GitlabError;
  }
  throw new Error("expected a failure");
};

describe("one status from GitHub's state", () => {
  const table: [string | undefined, DeploymentStatus][] = [
    [undefined, "created"],
    ["queued", "created"],
    ["pending", "created"],
    ["in_progress", "running"],
    ["success", "success"],
    // GitHub marks an earlier success `inactive` when a later one replaces it: it did succeed
    ["inactive", "success"],
    ["failure", "failed"],
    ["error", "failed"],
    // a word GitHub adds later is not a guess
    ["something_new", "unknown"],
  ];
  for (const [state, status] of table) {
    test(`${state ?? "no status"} is ${status}`, () => {
      expect(deploymentStatusOf(state)).toBe(status);
    });
  }
});

describe("deployments", () => {
  test("list answers newest first, in the platform's shape, with the newest status deciding", async () => {
    const { deployments, project } = setup();
    const first = mock.addDeployment("acme", "svc", { environment: "staging", state: "success" });
    const second = mock.addDeployment("acme", "svc", { environment: "production" });
    mock.setDeployment("acme", "svc", second.id, "in_progress");
    mock.setDeployment(
      "acme",
      "svc",
      second.id,
      "failure",
      "https://github.example/acme/svc/actions/runs/1",
    );
    const listed = await collect(deployments.list(project));
    expect(listed.map((d) => d.id)).toEqual([second.id, first.id]);
    const [d] = listed;
    expect(Object.keys(d ?? {}).sort()).toEqual([
      "createdAt",
      "environment",
      "finishedAt",
      "id",
      "iid",
      "jobId",
      "pipelineId",
      "pipelineUrl",
      "ref",
      "sha",
      "status",
      "updatedAt",
    ]);
    expect(d).toMatchObject({
      environment: "production",
      ref: "main",
      status: "failed",
      iid: second.id,
      jobId: null,
      pipelineId: null,
      pipelineUrl: "https://github.example/acme/svc/actions/runs/1",
    });
    expect(d?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(d?.finishedAt).not.toBeNull();
  });

  test("a deployment still going is not finished; one nothing has reported on is created", async () => {
    const { deployments, project } = setup();
    const running = mock.addDeployment("acme", "svc", {
      environment: "staging",
      state: "in_progress",
    });
    const silent = mock.addDeployment("acme", "svc", { environment: "staging" });
    const got = await collect(deployments.list(project));
    expect(got.find((d) => d.id === running.id)).toMatchObject({
      status: "running",
      finishedAt: null,
    });
    expect(got.find((d) => d.id === silent.id)).toMatchObject({
      status: "created",
      finishedAt: null,
    });
  });

  test("a replaced success is still a success, finished when it succeeded and not when it was replaced", async () => {
    const { deployments, project } = setup();
    const old = mock.addDeployment("acme", "svc", { environment: "staging", state: "success" });
    const before = await deployments.get(project, old.id);
    mock.setDeployment("acme", "svc", old.id, "inactive");
    const after = await deployments.get(project, old.id);
    expect(after.status).toBe("success");
    expect(after.finishedAt).toBe(before.finishedAt);
  });

  test("an address that is not a web one is not passed on", async () => {
    const { deployments, project } = setup();
    const d = mock.addDeployment("acme", "svc", { environment: "staging", state: "queued" });
    mock.setDeployment("acme", "svc", d.id, "success", "javascript:alert(1)");
    expect((await deployments.get(project, d.id)).pipelineUrl).toBeNull();
  });

  test("one environment is asked for by name, and pages are followed", async () => {
    const { deployments, project } = setup({ maxPerPage: 2 });
    for (let i = 0; i < 5; i++)
      mock.addDeployment("acme", "svc", { environment: "staging", state: "success" });
    mock.addDeployment("acme", "svc", { environment: "production", state: "success" });
    expect(await collect(deployments.list(project, { environment: "staging" }))).toHaveLength(5);
    expect(await collect(deployments.list(project))).toHaveLength(6);
  });

  test("get reads one; an unknown deployment and an unknown repository are not_found; a bad id is not asked", async () => {
    const { deployments, project } = setup();
    const d = mock.addDeployment("acme", "svc", { environment: "staging", state: "success" });
    expect((await deployments.get(project, d.id)).id).toBe(d.id);
    expect((await failure(deployments.get(project, 2_000_000_000))).kind).toBe("not_found");
    expect((await failure(collect(deployments.list("acme/none")))).kind).toBe("not_found");
    const before = mock.requests.length;
    expect((await failure(deployments.get(project, -1))).kind).toBe("invalid");
    expect(mock.requests).toHaveLength(before);
  });
});

describe("environments", () => {
  test("list answers the platform's shape", async () => {
    const { environments, project } = setup();
    mock.addEnvironment("acme", "svc", "staging");
    mock.addEnvironment("acme", "svc", "production");
    const got = await collect(environments.list(project));
    expect(got.map((e) => e.name).sort()).toEqual(["production", "staging"]);
    expect(got[0]).toEqual({
      id: expect.any(Number),
      name: expect.any(String),
      slug: expect.any(String),
      state: "available",
    });
    expect(got.every((e) => e.slug === e.name)).toBe(true);
  });
});
