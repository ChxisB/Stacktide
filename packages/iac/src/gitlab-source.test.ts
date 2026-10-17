import { afterEach, describe, expect, test } from "bun:test";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { detectChanges, gitlabSource } from "./gitlab-source";
import { scanStacks } from "./scan";

const HTTP = 'terraform {\n  backend "http" {}\n}\n';
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function setup(files: Record<string, string>, maxPerPage?: number) {
  const mock = createMockGitlab(maxPerPage ? { maxPerPage } : {});
  stops.push(() => mock.stop());
  const project = mock.addProject({ path: "acme/infra", defaultBranch: "main", files });
  const gitlab = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  return { mock, project, gitlab };
}

const collect = async (it: AsyncIterable<string>) => {
  const out: string[] = [];
  for await (const p of it) out.push(p);
  return out;
};

test("files are the blobs of the whole tree, at any depth, with no directories", async () => {
  const { project, gitlab } = setup({
    "README.md": "x",
    "a/stack.yml": "x",
    "a/b/c/main.tf": "x",
  });
  const paths = await collect(gitlabSource(gitlab, project.id, "main").files());
  expect(paths.sort()).toEqual(["README.md", "a/b/c/main.tf", "a/stack.yml"]);
});

test("read returns the text of a file at the ref", async () => {
  const { project, gitlab } = setup({ "a/main.tf": HTTP });
  const source = gitlabSource(gitlab, project.id, "main");
  expect(await source.read("a/main.tf")).toBe(HTTP);
});

test("a file that is not there rejects, as the contract says", async () => {
  const { project, gitlab } = setup({ "a.tf": "x" });
  await expect(gitlabSource(gitlab, project.id, "main").read("nope.tf")).rejects.toMatchObject({
    name: "GitlabError",
    kind: "not_found",
  });
});

test("a ref that is not there rejects", async () => {
  const { project, gitlab } = setup({ "a.tf": "x" });
  await expect(collect(gitlabSource(gitlab, project.id, "gone").files())).rejects.toMatchObject({
    name: "GitlabError",
  });
});

test("scanning a repository on GitLab, across pages of the tree", async () => {
  const { project, gitlab } = setup(
    {
      "net/stack.yml": "name: net\ntool: tofu\n",
      "net/main.tf": HTTP,
      "app/stack.yml": "name: app\ntool: terraform\ndepends_on: [net]\n",
      "app/main.tf": HTTP,
      "app/vars.tf": "",
      "docs/readme.md": "",
    },
    2,
  );
  const { stacks, problems } = await scanStacks(gitlabSource(gitlab, project.id, "main"));
  expect(problems).toEqual([]);
  expect(stacks.map((s) => [s.name, s.path, s.tool, s.dependsOn])).toEqual([
    ["app", "app", "terraform", ["net"]],
    ["net", "net", "tofu", []],
  ]);
});

describe("detectChanges", () => {
  const repo = {
    "net/stack.yml": "name: net\ntool: tofu\n",
    "net/main.tf": HTTP,
    "app/stack.yml": "name: app\ntool: terraform\ndepends_on: [net]\nwatch: [modules/**]\n",
    "app/main.tf": HTTP,
    "db/stack.yml": "name: db\ntool: tofu\n",
    "db/old.tf": HTTP,
    "modules/a/main.tf": "x",
    "README.md": "x",
  };
  const scanMain = async (gitlab: ReturnType<typeof setup>["gitlab"], id: number) =>
    (await scanStacks(gitlabSource(gitlab, id, "main"))).stacks;

  test("a branch that edits, adds and deletes files touches the stacks they belong to", async () => {
    const { project, gitlab } = setup(repo);
    const stacks = await scanMain(gitlab, project.id);
    await gitlab.repository.commitFiles(
      project.id,
      { branch: "change", message: "m", startBranch: "main" },
      [
        { action: "update", path: "net/main.tf", content: "changed" },
        { action: "create", path: "net/new.tf", content: "x" },
        { action: "delete", path: "db/old.tf" },
        { action: "update", path: "README.md", content: "changed" },
      ],
    );
    expect(await detectChanges(gitlab, project.id, "main", "change", stacks)).toEqual({
      changed: ["db", "net"],
      incomplete: false,
    });
  });

  test("a shared module that a stack watches touches that stack", async () => {
    const { project, gitlab } = setup(repo);
    const stacks = await scanMain(gitlab, project.id);
    await gitlab.repository.commitFiles(
      project.id,
      { branch: "mod", message: "m", startBranch: "main" },
      [{ action: "update", path: "modules/a/main.tf", content: "changed" }],
    );
    expect(await detectChanges(gitlab, project.id, "main", "mod", stacks)).toEqual({
      changed: ["app"],
      incomplete: false,
    });
  });

  test("a branch with nothing new, and a ref against itself, touch nothing", async () => {
    const { project, gitlab } = setup(repo);
    const stacks = await scanMain(gitlab, project.id);
    await gitlab.repository.createBranch(project.id, "same", "main");
    const none = { changed: [], incomplete: false };
    expect(await detectChanges(gitlab, project.id, "main", "same", stacks)).toEqual(none);
    expect(await detectChanges(gitlab, project.id, "main", "main", stacks)).toEqual(none);
  });

  test("a ref that is not there is an error, not an empty answer", async () => {
    const { project, gitlab } = setup(repo);
    const stacks = await scanMain(gitlab, project.id);
    await expect(detectChanges(gitlab, project.id, "main", "gone", stacks)).rejects.toMatchObject({
      name: "GitlabError",
      kind: "not_found",
    });
  });

  // the mock cannot report a renamed file or a diff GitLab gave up on, so these are told to it
  const told = (files: { oldPath: string; newPath: string }[], timedOut = false) =>
    ({
      repository: { compare: async () => ({ commits: [], files, timedOut, sameRef: false }) },
    }) as unknown as Parameters<typeof detectChanges>[0];
  const stacks = [
    { name: "a", path: "a", watch: [] },
    { name: "b", path: "b", watch: [] },
  ];

  test("a renamed file touches the stack it left and the stack it joined", async () => {
    const gitlab = told([{ oldPath: "a/x.tf", newPath: "b/x.tf" }]);
    expect(await detectChanges(gitlab, 1, "main", "mr", stacks)).toEqual({
      changed: ["a", "b"],
      incomplete: false,
    });
  });

  test("the target is compared with the merge request's head, in that order", async () => {
    const calls: unknown[][] = [];
    const gitlab = {
      repository: {
        compare: async (...args: unknown[]) => {
          calls.push(args);
          return { commits: [], files: [], timedOut: false, sameRef: false };
        },
      },
    } as unknown as Parameters<typeof detectChanges>[0];
    await detectChanges(gitlab, 7, "target-sha", "head-sha", stacks);
    expect(calls).toEqual([[7, "target-sha", "head-sha"]]);
  });

  test("a diff GitLab gave up on touches every stack, and says so", async () => {
    const gitlab = told([{ oldPath: "a/x.tf", newPath: "a/x.tf" }], true);
    expect(await detectChanges(gitlab, 1, "main", "mr", stacks)).toEqual({
      changed: ["a", "b"],
      incomplete: true,
    });
  });

  test("a list as long as a diff list gets cut touches every stack; one short of it does not", async () => {
    const files = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ oldPath: `a/${i}.tf`, newPath: `a/${i}.tf` }));
    expect(await detectChanges(told(files(1000)), 1, "main", "mr", stacks)).toEqual({
      changed: ["a", "b"],
      incomplete: true,
    });
    expect(await detectChanges(told(files(999)), 1, "main", "mr", stacks)).toEqual({
      changed: ["a"],
      incomplete: false,
    });
  });
});
