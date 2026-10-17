import { afterEach, expect, test } from "bun:test";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { gitlabSource } from "./gitlab-source";
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
