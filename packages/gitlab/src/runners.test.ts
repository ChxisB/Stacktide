import { describe, expect, test } from "bun:test";
import { createGitlab, GitlabError } from "./index";
import { createMockGitlab } from "./mock/server";

function setup(opts: Parameters<typeof createMockGitlab>[0] = {}) {
  const mock = createMockGitlab(opts);
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const project = mock.addProject({ path: "g/p" });
  return { mock, api, project };
}

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("a project's runners", () => {
  test("lists what GitLab reports of each: id, state, paused, type, and nothing else", async () => {
    const { mock, api, project } = setup();
    const id = mock.addRunner("g/p", { tags: ["prod"], status: "online" });
    mock.addRunner("g/p", { tags: ["prod"], status: "offline", paused: true, type: "group_type" });
    const listed = await collect(api.runners.list(project.id));
    expect(listed).toEqual([
      { id, online: true, paused: false, status: "online", type: "project_type" },
      { id: id + 1, online: false, paused: true, status: "offline", type: "group_type" },
    ]);
    mock.stop();
  });

  test("keeps no address, description or tag text, however much GitLab sends", async () => {
    const { mock, api, project } = setup();
    mock.addRunner("g/p", {
      tags: ["prod"],
      description: "runner-canary-description",
      ipAddress: "10.99.99.99",
    });
    const text = JSON.stringify(await collect(api.runners.list(project.id)));
    expect(text).not.toContain("runner-canary-description");
    expect(text).not.toContain("10.99.99.99");
    mock.stop();
  });

  test("asks GitLab for the runners that have every tag given", async () => {
    const { mock, api, project } = setup();
    const both = mock.addRunner("g/p", { tags: ["a", "b"] });
    mock.addRunner("g/p", { tags: ["a"] });
    mock.addRunner("g/p", { tags: ["b", "c"] });
    expect(
      (await collect(api.runners.list(project.id, { tags: ["a", "b"] }))).map((r) => r.id),
    ).toEqual([both]);
    expect(await collect(api.runners.list(project.id, { tags: ["zzz"] }))).toEqual([]);
    expect(await collect(api.runners.list(project.id))).toHaveLength(3);
    mock.stop();
  });

  test("reads every page", async () => {
    const { mock, api, project } = setup({ maxPerPage: 2 });
    for (let i = 0; i < 5; i++) mock.addRunner("g/p", { tags: ["x"] });
    expect(await collect(api.runners.list(project.id, { tags: ["x"] }))).toHaveLength(5);
    mock.stop();
  });

  test("another project's runners are not listed, and an unknown project is not_found", async () => {
    const { mock, api, project } = setup();
    mock.addProject({ path: "g/other" });
    mock.addRunner("g/other", { tags: ["x"] });
    expect(await collect(api.runners.list(project.id))).toEqual([]);
    const e = await collect(api.runners.list(999_999)).catch((x) => x);
    expect(e).toBeInstanceOf(GitlabError);
    expect(e.kind).toBe("not_found");
    mock.stop();
  });

  test("a token without the permission is forbidden, not an empty list", async () => {
    const { mock, api, project } = setup();
    mock.inject({ method: "GET", path: /\/runners$/, status: 403 });
    const e = await collect(api.runners.list(project.id)).catch((x) => x);
    expect(e).toBeInstanceOf(GitlabError);
    expect(e.kind).toBe("forbidden");
    mock.stop();
  });

  test("a state GitLab adds later reads as unknown, never as online", async () => {
    const { mock, api, project } = setup();
    mock.addRunner("g/p", { tags: ["x"], status: "something_new" });
    const [r] = await collect(api.runners.list(project.id));
    expect(r).toMatchObject({ status: "unknown", online: false });
    mock.stop();
  });
});
