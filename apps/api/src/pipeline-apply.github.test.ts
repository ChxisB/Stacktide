import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DomainError } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  createSyncTarget,
  type NewStack,
  syncStacks,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { githubForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { type Platform, renderStackWorkflow } from "@orch/iac";
import { loadTemplates, render, renderWorkflow, type Template } from "@orch/pipelines";
import {
  applyPipeline,
  PIPELINE_BRANCH,
  type PipelineDeps,
  pipelineFileOf,
  previewPipeline,
} from "./pipeline-apply";

// FRG-13: the delivery (a file on a branch, one pull request) on a GitHub repository, through the mock.
// FRG-16: what is committed is the template's workflow, never its GitLab pipeline.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CONNECTION = "00000000-0000-7000-8000-000000000001";
const WORKFLOW = ".github/workflows/orch.yml";

let t: TestDb;
let catalog: Template[];
let mock: ReturnType<typeof createMockGithub>;
beforeAll(async () => {
  t = await createTestDb();
  catalog = await loadTemplates();
});
afterEach(() => mock?.stop());
afterAll(async () => {
  await t.drop();
});

const find = (name: string) => {
  const found = catalog.find((c) => c.manifest.name === name);
  if (!found) throw new Error(`no template ${name}`);
  return found;
};

let n = 0;
async function world(files?: Record<string, string>) {
  mock?.stop();
  mock = createMockGithub();
  const remote = mock.addRepo("acme", `svc${++n}`, files ? { files } : {});
  const forge = githubForge(
    createGithubClient({ baseUrl: mock.url, token: "ghp_not-a-real-token-1234", maxRetries: 0 }),
  );
  const org = await createOrganization(t.db, { slug: `gh${n}`, name: "O" });
  const project = await createProject(t.db, {
    organizationId: org.id,
    name: `svc${n}`,
    gitlabProjectId: remote.id,
  });
  const deps: PipelineDeps = { db: t.db, catalog, forge: async () => forge };
  const run = (request: Parameters<typeof applyPipeline>[4]) =>
    applyPipeline(deps, org.id, project.id, CONNECTION, request);
  const writes = () => mock.requests.filter((r) => r.method !== "GET");
  const file = (ref: string) =>
    forge.repository.getFile(remote.id, WORKFLOW, ref).then(
      (f) => f.content,
      () => null,
    );
  return { org, project, remote, forge, deps, run, writes, file };
}

const bun = { template: "bun-app" } as const;

describe("the pipeline delivered to a GitHub repository", () => {
  test("the file is named for the forge", () => {
    expect(pipelineFileOf("github")).toBe(WORKFLOW);
    expect(pipelineFileOf("gitlab")).toBe(".gitlab-ci.yml");
  });

  test("a first run commits to a branch and opens one pull request; the default branch is untouched", async () => {
    const w = await world();
    const r = await w.run(bun);

    expect(r).toMatchObject({ outcome: "opened", committed: true, existing: "none" });
    expect(r.mr).toEqual({ iid: 1, url: expect.stringContaining("/pull/1") });
    const committed = await w.file(PIPELINE_BRANCH);
    expect(committed).toBe((await previewPipeline(w.deps, w.org.id, w.project.id, bun)).text);
    // a workflow (FRG-16), not the GitLab pipeline the same template renders for GitLab
    expect(committed).toBe(renderWorkflow(find("bun-app")));
    expect(committed).not.toBe(render(find("bun-app")));
    expect(committed).toContain("\njobs:\n");
    expect(committed).not.toContain("stages:");
    expect(await w.file("main")).toBeNull();

    const pulls = [];
    for await (const p of w.forge.mergeRequests.list(w.remote.id)) pulls.push(p);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({
      state: "opened",
      sourceBranch: PIPELINE_BRANCH,
      targetBranch: "main",
    });
    expect(pulls[0]?.description).toContain(`adds \`${WORKFLOW}\``);
    expect(pulls[0]?.description).not.toContain(".gitlab-ci.yml");
    // invariant 6: no write names the default branch
    expect(w.writes().filter((x) => JSON.stringify(x.body ?? "").includes('heads/main"'))).toEqual(
      [],
    );
    expect(w.writes().filter((x) => x.path.endsWith("/heads/main"))).toEqual([]);
  });

  test("says that the workflow was not checked, and does not call a lint it has not got", async () => {
    const w = await world();
    const r = await w.run(bun);
    expect(r.validation.lint.valid).toBe(true);
    expect(r.validation.lint.warnings).toEqual([expect.stringContaining("was not checked")]);
    const pull = await w.forge.mergeRequests.get(w.remote.id, 1);
    expect(pull.description).toContain("Not checked");
    expect(pull.description).not.toContain("GitLab");
  });

  test("a second run with the same inputs writes nothing", async () => {
    const w = await world();
    await w.run(bun);
    const before = w.writes().length;
    const again = await w.run(bun);
    expect(again).toMatchObject({ outcome: "unchanged", committed: false });
    expect(again.mr?.iid).toBe(1);
    expect(w.writes()).toHaveLength(before);
  });

  test("other inputs commit on the same branch and edit the same pull request", async () => {
    const w = await world();
    await w.run(bun);
    const r = await w.run({ ...bun, params: { bunVersion: "1.2" } });
    expect(r).toMatchObject({ outcome: "updated", committed: true });
    expect(r.mr?.iid).toBe(1);
    const pulls = [];
    for await (const p of w.forge.mergeRequests.list(w.remote.id)) pulls.push(p);
    expect(pulls).toHaveLength(1);
  });

  test("a hand-written workflow on the default branch is found, and replaced only by the pull request", async () => {
    const w = await world({ [WORKFLOW]: "name: mine\n" });
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "opened", committed: true, existing: "hand-written" });
    expect(await w.file("main")).toBe("name: mine\n");
    const pull = await w.forge.mergeRequests.get(w.remote.id, 1);
    expect(pull.description).toContain(`replaces the \`${WORKFLOW}\``);
  });

  test("the workflow already in place on the default branch is left alone", async () => {
    const first = await world();
    const text = (await previewPipeline(first.deps, first.org.id, first.project.id, bun)).text;
    const w = await world({ [WORKFLOW]: text });
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "in_place", committed: false, mr: null });
    expect(w.writes()).toEqual([]);
  });

  test("previewing writes nothing", async () => {
    const w = await world();
    const p = await previewPipeline(w.deps, w.org.id, w.project.id, bun);
    expect(p.existing).toBe("none");
    expect(w.writes()).toEqual([]);
  });

  test("a repository GitHub does not show is reported as GitHub, not GitLab", async () => {
    const w = await world();
    mock.inject({ method: "GET", path: `/repositories/${w.remote.id}`, status: 404, times: 9 });
    const e = await w.run(bun).catch((x) => x);
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toMatchObject({ code: "gitlab_project_unreachable", status: 422 });
    expect(e.message).toContain("GitHub has no such repository");
    expect(e.message).not.toContain("GitLab");
  });

  test("an include or a component is refused: GitHub reads a whole workflow, and nothing is written", async () => {
    const w = await world();
    for (const mode of ["include", "component"] as const) {
      const e = await w
        .run({ ...bun, mode, include: { project: "acme/templates", ref: "1.0.0" } })
        .catch((x) => x);
      expect(e).toBeInstanceOf(DomainError);
      expect(e).toMatchObject({ code: "invalid_pipeline", status: 422 });
      expect(e.message).toContain(`GitHub has no ${mode} mode`);
    }
    expect(w.writes()).toEqual([]);
  });

  test("a template with no workflow, and secret detection, are refused by name; nothing is written", async () => {
    const w = await world();
    const deploy = await w.run({ template: "docker-deploy" }).catch((x) => x);
    expect(deploy).toMatchObject({ code: "invalid_pipeline", status: 422 });
    expect(deploy.message).toBe("docker-deploy@1.0.0 has no GitHub Actions form yet");
    const scan = await w.run({ ...bun, params: { secretDetection: true } }).catch((x) => x);
    expect(scan).toMatchObject({ code: "invalid_pipeline", status: 422 });
    expect(scan.message).toContain("secretDetection");
    expect(w.writes()).toEqual([]);
  });

  test("a GitLab key in an override is refused, not committed to a file GitHub would reject", async () => {
    const w = await world();
    const e = await w.run({ ...bun, overrides: { stages: ["a"] } }).catch((x) => x);
    expect(e).toMatchObject({ code: "invalid_pipeline", status: 422 });
    expect(e.message).toContain("`stages`");
    expect(w.writes()).toEqual([]);
  });
});

// FRG-31: a GitHub project that has stacks gets the workflow that runs them in the same pull request.

const STACKS = ".github/workflows/orch-stacks.yml";
const PLATFORM: Platform = { apiUrl: "https://orch.example.com", audience: "orch-platform" };
const stack = (name: string): NewStack => ({
  name,
  path: name,
  tool: "tofu",
  version: "1.9.8",
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "http",
});

/** A world whose project has stacks and whose deployment knows where it is. */
async function withStacks(files?: Record<string, string>, platform: Platform | null = PLATFORM) {
  const w = await world(files);
  await syncStacks(t.db, w.org.id, w.project.id, [stack("net"), stack("app")], { prune: false });
  if (platform) w.deps.platform = platform;
  const at = (path: string, ref: string) =>
    w.forge.repository.getFile(w.remote.id, path, ref).then(
      (f) => f.content,
      () => null,
    );
  return { ...w, at };
}

describe("the stack workflow delivered with the pipeline", () => {
  test("one pull request holds both files, the second equal to renderStackWorkflow, and main is untouched", async () => {
    const w = await withStacks();
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "opened", committed: true });
    expect(await w.at(WORKFLOW, PIPELINE_BRANCH)).toBe(renderWorkflow(find("bun-app")));
    expect(await w.at(STACKS, PIPELINE_BRANCH)).toBe(renderStackWorkflow(PLATFORM));
    expect(await w.at(STACKS, "main")).toBeNull();
    expect(await w.at(WORKFLOW, "main")).toBeNull();
    const pulls = [];
    for await (const p of w.forge.mergeRequests.list(w.remote.id)) pulls.push(p);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]?.description).toContain(`\`${STACKS}\``);
    // invariant 6: no write names the default branch
    expect(w.writes().filter((x) => x.path.endsWith("/heads/main"))).toEqual([]);
  });

  test("a repeat is a no-op", async () => {
    const w = await withStacks();
    await w.run(bun);
    const before = w.writes().length;
    const again = await w.run(bun);
    expect(again).toMatchObject({ outcome: "unchanged", committed: false });
    expect(w.writes()).toHaveLength(before);
  });

  test("a new address or audience changes the file in the same pull request", async () => {
    const w = await withStacks();
    await w.run(bun);
    const moved: Platform = { apiUrl: "https://orch.other.example", audience: "other" };
    w.deps.platform = moved;
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "updated", committed: true });
    expect(r.mr?.iid).toBe(1);
    expect(await w.at(STACKS, PIPELINE_BRANCH)).toBe(renderStackWorkflow(moved));
  });

  test("a stack workflow on the default branch that differs is changed by the pull request, never in place", async () => {
    const w = await withStacks({ [STACKS]: "name: mine\n" });
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "opened", committed: true });
    expect(await w.at(STACKS, "main")).toBe("name: mine\n");
    expect(await w.at(STACKS, PIPELINE_BRANCH)).toBe(renderStackWorkflow(PLATFORM));
    expect((await w.forge.mergeRequests.get(w.remote.id, 1)).description).toContain(
      `updates \`${STACKS}\``,
    );
  });

  test("a pipeline in place but a stack workflow missing still opens a pull request, with the one file", async () => {
    const first = await world();
    const text = (await previewPipeline(first.deps, first.org.id, first.project.id, bun)).text;
    const w = await withStacks({ [WORKFLOW]: text });
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "opened", committed: true, existing: "identical" });
    expect(await w.at(STACKS, PIPELINE_BRANCH)).toBe(renderStackWorkflow(PLATFORM));
    const { description } = await w.forge.mergeRequests.get(w.remote.id, 1);
    expect(description).toContain(`\`${WORKFLOW}\` is already as it should be`);
    expect(description).toContain(`adds \`${STACKS}\``);
    expect(description).not.toContain("written by hand");
  });

  test("a guardrail the pipeline breaks has nothing to refuse when the pipeline is already in place: the stack workflow still goes", async () => {
    const first = await world();
    const text = (await previewPipeline(first.deps, first.org.id, first.project.id, bun)).text;
    const w = await withStacks({ [WORKFLOW]: text });
    await createEnvironment(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      name: "prod",
      slug: "prod",
    });
    const connection = await createConnection(t.db, keys, {
      organizationId: w.org.id,
      type: "gitlab",
      name: "c",
      token: "zz-not-a-token-0001",
    });
    await createSyncTarget(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      name: "main",
      type: "gitlab-variables",
      connectionId: connection.id,
      config: { project: "fx/p", protected: false },
      environmentMapping: { prod: "production" },
    });
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "opened", committed: true });
    expect(r.validation.violations).toHaveLength(1);
    expect(await w.at(STACKS, PIPELINE_BRANCH)).toBe(renderStackWorkflow(PLATFORM));
  });

  test("a stack workflow already in place is not mentioned when only the pipeline changes", async () => {
    const w = await withStacks({ [STACKS]: renderStackWorkflow(PLATFORM) });
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "opened", committed: true });
    const { description } = await w.forge.mergeRequests.get(w.remote.id, 1);
    expect(description).not.toContain("orch-stacks");
    expect(w.writes().some((x) => x.path.includes("orch-stacks"))).toBe(false);
  });

  test("both already in place on the default branch writes nothing", async () => {
    const first = await world();
    const text = (await previewPipeline(first.deps, first.org.id, first.project.id, bun)).text;
    const w = await withStacks({ [WORKFLOW]: text, [STACKS]: renderStackWorkflow(PLATFORM) });
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "in_place", committed: false, mr: null });
    expect(w.writes()).toEqual([]);
  });

  test("a project with no stacks needs no address: nothing is said about the stack workflow", async () => {
    const w = await world();
    await w.run(bun);
    const pull = await w.forge.mergeRequests.get(w.remote.id, 1);
    expect(pull.description).not.toContain("ORCH_API_URL");
    expect(pull.description).not.toContain("orch-stacks");
  });

  test("a project with no stacks gets the pipeline only", async () => {
    const w = await world();
    w.deps.platform = PLATFORM;
    await w.run(bun);
    expect(await w.file(PIPELINE_BRANCH)).not.toBeNull();
    const pull = await w.forge.mergeRequests.get(w.remote.id, 1);
    expect(pull.description).not.toContain("orch-stacks");
    expect(
      await w.forge.repository.getFile(w.remote.id, STACKS, PIPELINE_BRANCH).catch(() => null),
    ).toBeNull();
  });

  test("stacks but no address for the platform: the pipeline only, and the pull request says why", async () => {
    const w = await withStacks(undefined, null);
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "opened", committed: true });
    expect(await w.at(STACKS, PIPELINE_BRANCH)).toBeNull();
    const pull = await w.forge.mergeRequests.get(w.remote.id, 1);
    expect(pull.description).toContain("ORCH_API_URL");
    expect(pull.description).toContain("ORCH_CI_AUDIENCE");
  });

  test("an address the workflow cannot carry is refused and nothing is written", async () => {
    const w = await withStacks(undefined, { apiUrl: "ftp://orch", audience: "orch" });
    const e = await w.run(bun).catch((x) => x);
    expect(e).toBeInstanceOf(DomainError);
    expect(e).toMatchObject({ code: "invalid_pipeline", status: 422 });
    expect(e.message).toContain("apiUrl");
    expect(w.writes()).toEqual([]);
  });
});
