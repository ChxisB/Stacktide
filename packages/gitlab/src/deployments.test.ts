import { describe, expect, test } from "bun:test";
import type { GitlabClient } from "./client";
import { deploymentsApi } from "./deployments";
import { createGitlab, GitlabError } from "./index";
import { createMockGitlab } from "./mock/server";

// DEP-2: what GitLab says a deployment is, kept to ids, a name, a sha, a status and times: never the user or the commit.

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

function ready(maxPerPage?: number) {
  const mock = createMockGitlab({ maxPerPage });
  const web = mock.addProject({ path: "g/web" });
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  return { mock, api, web };
}

/** The parser on a payload the mock would never send: what a real GitLab adds, and what an API-made deployment lacks. */
const parsed = (...raw: unknown[]) =>
  collect(
    deploymentsApi({
      paginate: async function* () {
        yield* raw;
      },
    } as unknown as GitlabClient).deployments.list("g/web"),
  );

const SHA = "a".repeat(40);

describe("deployments", () => {
  test("a page of them decodes, and the next page is followed", async () => {
    const { mock, api } = ready(2);
    for (const n of [1, 2, 3, 4, 5])
      mock.addDeployment("g/web", { environment: "staging", sha: String(n).repeat(40) });
    const all = await collect(api.deployments.list("g/web"));
    expect(all.map((d) => d.sha[0])).toEqual(["1", "2", "3", "4", "5"]);
    expect(all[0]).toMatchObject({ environment: "staging", status: "success", ref: "main" });
  });

  test("an unknown status reads unknown, and a known one is kept", async () => {
    const out = await parsed(
      { ...base(1), status: "success" },
      { ...base(2), status: "a-word-gitlab-adds-later" },
    );
    expect(out.map((d) => d.status)).toEqual(["success", "unknown"]);
  });

  test("a payload with the user and the commit comes out without them: exactly these keys", async () => {
    const [d] = await parsed({
      ...base(7),
      user: { id: 1, username: "ada", name: "Ada Lovelace", email: "ada@example.test" },
      commit: { id: SHA, title: "fix the thing (secret-ish words)", author_email: "a@b.test" },
      environment: { id: 3, name: "staging", slug: "staging", external_url: "https://x.test" },
      deployable: {
        id: 11,
        name: "deploy",
        finished_at: "2026-10-01T10:00:00Z",
        pipeline: { id: 12, web_url: "https://gl.test/p/12" },
        user: { username: "ada" },
        commit: { title: "hidden" },
      },
    });
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
      id: 7,
      environment: "staging",
      jobId: 11,
      pipelineId: 12,
      pipelineUrl: "https://gl.test/p/12",
    });
    expect(JSON.stringify(d)).not.toContain("Ada");
    expect(JSON.stringify(d)).not.toContain("hidden");
  });

  test("one made through the API has no job and no pipeline: both are null", async () => {
    const [d] = await parsed({ ...base(8), deployable: null });
    expect(d).toMatchObject({ jobId: null, pipelineId: null, pipelineUrl: null, finishedAt: null });
    const [e] = await parsed(base(9));
    expect(e).toMatchObject({ jobId: null, pipelineId: null, pipelineUrl: null });
  });

  test("a pipeline address that is not a web address is dropped, as is a missing one", async () => {
    const withUrl = (web_url: unknown) =>
      parsed({ ...base(10), deployable: { id: 1, pipeline: { id: 2, web_url } } });
    expect((await withUrl("javascript:alert(1)"))[0]?.pipelineUrl).toBeNull();
    expect((await withUrl(null))[0]?.pipelineUrl).toBeNull();
    expect((await withUrl("http://gl.test/p/2"))[0]?.pipelineUrl).toBe("http://gl.test/p/2");
  });

  test("the time it finished is the deployment's own when GitLab sends one, else its job's", async () => {
    const [own, job] = await parsed(
      { ...base(1), finished_at: "2026-10-02T00:00:00Z" },
      { ...base(2), deployable: { id: 5, finished_at: "2026-10-03T00:00:00Z" } },
    );
    expect(own?.finishedAt).toBe("2026-10-02T00:00:00Z");
    expect(job?.finishedAt).toBe("2026-10-03T00:00:00Z");
  });

  test("an answer with no environment is refused, naming the field and not the value", async () => {
    await expect(parsed({ ...base(1), environment: null })).rejects.toThrow(/environment/);
  });

  test("it asks for one environment and one status, newest first, as it is told", async () => {
    const { mock, api } = ready();
    mock.addDeployment("g/web", { environment: "staging", sha: "1".repeat(40) });
    mock.addDeployment("g/web", { environment: "production", sha: "2".repeat(40) });
    mock.addDeployment("g/web", { environment: "staging", sha: "3".repeat(40), status: "failed" });
    const staging = await collect(api.deployments.list("g/web", { environment: "staging" }));
    expect(staging.map((d) => d.sha[0])).toEqual(["1", "3"]);
    const failed = await collect(api.deployments.list("g/web", { status: "failed" }));
    expect(failed.map((d) => d.sha[0])).toEqual(["3"]);
    const newest = await collect(api.deployments.list("g/web", { orderBy: "id", sort: "desc" }));
    expect(newest.map((d) => d.sha[0])).toEqual(["3", "2", "1"]);
  });

  test("get reads one; an unknown one is not_found, and so is an unknown project", async () => {
    const { mock, api } = ready();
    const id = mock.addDeployment("g/web", {
      environment: "staging",
      sha: SHA,
      status: "running",
      job: 41,
      pipeline: 40,
    });
    expect(await api.deployments.get("g/web", id)).toMatchObject({
      id,
      status: "running",
      jobId: 41,
      pipelineId: 40,
    });
    await expect(api.deployments.get("g/web", 999)).rejects.toMatchObject({ kind: "not_found" });
    await expect(api.deployments.get("g/none", id)).rejects.toBeInstanceOf(GitlabError);
  });
});

describe("environments", () => {
  test("a project's list: a name, a slug and whether it is available; a deployment makes one", async () => {
    const { mock, api } = ready();
    mock.addDeployment("g/web", { environment: "staging", sha: SHA });
    mock.addEnvironment("g/web", "production");
    const envs = await collect(api.environments.list("g/web"));
    expect(envs.map((e) => [e.name, e.slug, e.state])).toEqual([
      ["staging", "staging", "available"],
      ["production", "production", "available"],
    ]);
    expect(Object.keys(envs[0] ?? {}).sort()).toEqual(["id", "name", "slug", "state"]);
  });

  test("an unknown state reads unknown", async () => {
    const out = await collect(
      deploymentsApi({
        paginate: async function* () {
          yield { id: 1, name: "qa", slug: "qa", state: "something-new", external_url: "x" };
        },
      } as unknown as GitlabClient).environments.list("g/web"),
    );
    expect(out[0]?.state).toBe("unknown");
  });
});

function base(id: number) {
  return {
    id,
    iid: id,
    ref: "main",
    sha: SHA,
    status: "success",
    created_at: "2026-10-01T09:00:00Z",
    updated_at: "2026-10-01T09:05:00Z",
    environment: { id: 3, name: "staging" },
  };
}
