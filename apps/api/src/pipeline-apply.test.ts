import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { DomainError } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import { createEnvironment, createOrganization, createProject, createVariable } from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { loadTemplates, render, type Template } from "@orch/pipelines";
import {
  applyPipeline,
  PIPELINE_BRANCH,
  PIPELINE_FILE,
  type PipelineDeps,
  previewPipeline,
} from "./pipeline-apply";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CONNECTION = "00000000-0000-7000-8000-000000000001";

let t: TestDb;
let catalog: Template[];
let mock: ReturnType<typeof createMockGitlab>;
beforeAll(async () => {
  t = await createTestDb();
  catalog = await loadTemplates();
});
afterEach(() => mock?.stop());
afterAll(async () => {
  await t.drop();
});

let n = 0;
/** An organization, a project linked to a mock GitLab project, and the client the service is given. */
async function world(
  files?: Record<string, string>,
  options: Parameters<typeof createMockGitlab>[0] = {},
) {
  mock?.stop();
  mock = createMockGitlab(options);
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const remote = mock.addProject({ path: `fx/p${++n}`, files });
  const org = await createOrganization(t.db, { slug: `o${n}`, name: "O" });
  const project = await createProject(t.db, {
    organizationId: org.id,
    name: `p${n}`,
    gitlabProjectId: remote.id,
  });
  const opened: number[] = [];
  const deps: PipelineDeps = {
    db: t.db,
    catalog,
    gitlab: async () => {
      opened.push(1);
      return api;
    },
  };
  const run = (request: Parameters<typeof applyPipeline>[4], c: string = CONNECTION) =>
    applyPipeline(deps, org.id, project.id, c, request);
  const file = async (ref: string) =>
    api.repository.getFile(remote.id, PIPELINE_FILE, ref).then(
      (f) => f.content,
      () => null,
    );
  const commits = () =>
    mock.requests.filter((r) => r.method === "POST" && r.path.endsWith("/repository/commits"))
      .length;
  const mrs = async () => {
    const out = [];
    for await (const m of api.mergeRequests.list(remote.id)) out.push(m);
    return out;
  };
  return { org, project, remote, api, deps, run, file, commits, mrs, opened };
}

const bun = { template: "bun-app" } as const;
const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return e as DomainError;
  }
  throw new Error("did not throw");
};

describe("applyPipeline", () => {
  test("a first run commits to a branch and opens one merge request; the default branch is untouched", async () => {
    const w = await world();
    const before = await w.file("main");
    const r = await w.run(bun);

    expect(r).toMatchObject({ outcome: "opened", committed: true, existing: "none" });
    const text = render(catalog.find((c) => c.manifest.name === "bun-app") as Template);
    expect(await w.file(PIPELINE_BRANCH)).toBe(text);
    expect(await w.file("main")).toBe(before); // nothing landed on the default branch
    expect(before).toBeNull();
    expect(r.renderedHash).toBe(new Bun.CryptoHasher("sha256").update(text).digest("hex"));

    const all = await w.mrs();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      state: "opened",
      sourceBranch: PIPELINE_BRANCH,
      targetBranch: "main",
      webUrl: r.mr?.url,
    });
    expect(all[0]?.description).toContain("bun-app");
    expect(all[0]?.description).toContain("adds `.gitlab-ci.yml`");
    expect(r.config).toMatchObject({
      organizationId: w.org.id,
      projectId: w.project.id,
      connectionId: CONNECTION,
      template: "bun-app",
      version: "1.0.0",
      params: {},
      overrides: {},
      mrIid: r.mr?.iid,
      mrUrl: r.mr?.url,
    });
  });

  test("running it again with the same inputs makes no commit and changes nothing", async () => {
    const w = await world();
    const first = await w.run(bun);
    const commits = w.commits();
    const second = await w.run(bun);

    expect(second).toMatchObject({ outcome: "unchanged", committed: false, mr: first.mr });
    expect(w.commits()).toBe(commits);
    expect(await w.mrs()).toHaveLength(1);
    expect(second.config.renderedHash).toBe(first.config.renderedHash);
  });

  test("GitLab storing the description with other line endings is not an edit", async () => {
    const w = await world();
    const first = await w.run(bun);
    const [mr] = await w.mrs();
    await w.api.mergeRequests.update(w.remote.id, first.mr?.iid ?? 0, {
      description: `${mr?.description.replaceAll("\n", "\r\n")}\r\n`,
    });
    const writes = () => mock.requests.filter((r) => r.method === "PUT").length;
    const before = writes();
    const again = await w.run(bun);
    expect(again.outcome).toBe("unchanged");
    expect(writes()).toBe(before);
  });

  test("other parameters commit on the same branch and edit the same merge request", async () => {
    const w = await world();
    const first = await w.run(bun);
    const second = await w.run({ ...bun, params: { bunVersion: "1.2" } });

    expect(second).toMatchObject({ outcome: "updated", committed: true });
    expect(second.mr).toEqual(first.mr);
    expect(await w.file(PIPELINE_BRANCH)).toContain("image: oven/bun:1.2");
    const all = await w.mrs();
    expect(all).toHaveLength(1);
    expect(all[0]?.description).toContain('`bunVersion` = `"1.2"`');
    expect(await w.file("main")).toBeNull();
    expect(second.config.params).toEqual({ bunVersion: "1.2" });
  });

  test("a hand-written .gitlab-ci.yml is replaced only by the merge request, which says so", async () => {
    const mine = "stages: [mine]\nmine:\n  stage: mine\n  script: [echo hand written]\n";
    const w = await world({ "README.md": "# x\n", [PIPELINE_FILE]: mine });
    const r = await w.run(bun);

    expect(r).toMatchObject({ outcome: "opened", existing: "hand-written" });
    expect(await w.file("main")).toBe(mine); // still there until someone merges
    expect(await w.file(PIPELINE_BRANCH)).toContain("Generated by orch");
    const [mr] = await w.mrs();
    expect(mr?.description).toContain("written by hand");
    expect(mr?.description).toContain("Read the diff");
    const diff = await w.api.repository.compare(w.remote.id, "main", PIPELINE_BRANCH);
    expect(diff.files).toEqual([
      { oldPath: PIPELINE_FILE, newPath: PIPELINE_FILE, status: "modified" },
    ]);
  });

  test("a file of ours on the default branch is updated, and one that is already right needs no merge request", async () => {
    const text = render(catalog.find((c) => c.manifest.name === "bun-app") as Template);
    const same = await world({ [PIPELINE_FILE]: text });
    const r = await same.run(bun);
    expect(r).toMatchObject({
      outcome: "in_place",
      committed: false,
      existing: "identical",
      mr: null,
    });
    expect(same.commits()).toBe(0);
    expect(await same.mrs()).toEqual([]);
    expect(r.config).toMatchObject({ mrIid: null, mrUrl: null });

    const older = await world({ [PIPELINE_FILE]: text.replace("oven/bun:1", "oven/bun:0") });
    const u = await older.run(bun);
    expect(u).toMatchObject({ outcome: "opened", existing: "generated" });
    expect((await older.mrs())[0]?.description).toContain("updates `.gitlab-ci.yml`");
  });

  test("a merged merge request is not reopened: a later change opens a new one on the branch again", async () => {
    const w = await world();
    const first = await w.run(bun);
    // someone merged it: the default branch now has the file, and the merge request is closed
    await w.api.mergeRequests.update(w.remote.id, first.mr?.iid ?? 0, { state: "closed" });
    const again = await w.run(bun);
    expect(again).toMatchObject({ outcome: "opened", committed: false });
    expect(again.mr?.iid).not.toBe(first.mr?.iid);
    expect(await w.mrs()).toHaveLength(2);
  });

  test("a pipeline GitLab's lint refuses is committed nowhere", async () => {
    const w = await world();
    const e = await failure(w.run({ ...bun, overrides: { broken: { stage: "check" } } }));
    expect(e).toMatchObject({ code: "pipeline_invalid", status: 422 });
    expect(e.message).toContain("script");
    expect(w.commits()).toBe(0);
    expect(await w.mrs()).toEqual([]);
  });

  test("required variables that are not set are listed in the merge request and do not stop it", async () => {
    const w = await world();
    const needing = catalog.map((c) =>
      c.manifest.name === "bun-app"
        ? { ...c, manifest: { ...c.manifest, requiresVariables: ["DEPLOY_TOKEN", "REGION"] } }
        : c,
    );
    await createEnvironment(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      name: "prod",
      slug: "prod",
    });
    await createVariable(t.db, keys, {
      organizationId: w.org.id,
      projectId: w.project.id,
      key: "REGION",
      kind: "plain",
      value: "eu",
      actor: { kind: "user", id: "u1" },
    });
    const r = await applyPipeline(
      { ...w.deps, catalog: needing },
      w.org.id,
      w.project.id,
      CONNECTION,
      bun,
    );
    expect(r.outcome).toBe("opened");
    expect(r.validation.missingVariables).toEqual([
      { environment: "prod", keys: ["DEPLOY_TOKEN"] },
    ]);
    const [mr] = await w.mrs();
    expect(mr?.description).toContain("not set yet");
    expect(mr?.description).toContain("`prod`: `DEPLOY_TOKEN`");
    expect(mr?.description).not.toContain("REGION");
  });

  test("GitLab's warnings are in the merge request, backticks and all cut down", async () => {
    const w = await world(undefined, { lintWarnings: ["job `build` may never run", "second"] });
    await w.run(bun);
    const [mr] = await w.mrs();
    expect(mr?.description).toContain("- job 'build' may never run");
    expect(mr?.description).toContain("- second");
  });

  test("an unknown template or version, and parameters the template refuses, are 422 with GitLab left alone", async () => {
    const w = await world();
    expect(await failure(w.run({ template: "nope" }))).toMatchObject({
      code: "unknown_template",
      status: 422,
    });
    expect(await failure(w.run({ ...bun, version: "9.9.9" }))).toMatchObject({
      code: "unknown_template",
    });
    const bad = await failure(w.run({ ...bun, params: { bunVersion: "1; rm -rf /", nope: 1 } }));
    expect(bad).toMatchObject({ code: "invalid_pipeline", status: 422 });
    expect(bad.message).not.toContain("rm -rf");
    expect(w.opened).toEqual([]); // never even opened the connection
    expect(mock.requests).toEqual([]);
  });

  test("a project that is not there, or not linked to GitLab, is refused before GitLab is opened", async () => {
    const w = await world();
    const other = await createOrganization(t.db, { slug: `x${++n}`, name: "X" });
    expect(
      await failure(applyPipeline(w.deps, other.id, w.project.id, CONNECTION, bun)),
    ).toMatchObject({ code: "not_found", status: 404 });
    const loose = await createProject(t.db, { organizationId: w.org.id, name: `loose${n}` });
    expect(await failure(applyPipeline(w.deps, w.org.id, loose.id, CONNECTION, bun))).toMatchObject(
      { code: "not_linked", status: 422 },
    );
    expect(w.opened).toEqual([]);
  });

  test("an unknown environment is 422 and nothing is written", async () => {
    const w = await world();
    expect(await failure(w.run({ ...bun, environments: ["nope"] }))).toMatchObject({
      code: "unknown_environment",
    });
    expect(w.commits()).toBe(0);
  });

  test("GitLab refusing the project is 422, GitLab being down is 502, and neither leaks the token", async () => {
    const w = await world();
    mock.inject({ method: "GET", path: /\/projects\/\d+$/, status: 404 });
    expect(await failure(w.run(bun))).toMatchObject({
      code: "gitlab_project_unreachable",
      status: 422,
    });
    mock.inject({ method: "GET", path: /\/projects\/\d+$/, status: 500, times: 5 });
    const down = await failure(w.run(bun));
    expect(down).toMatchObject({ code: "gitlab_failed", status: 502 });
    expect(JSON.stringify(down.message)).not.toContain(mock.token);
  });

  test("GitLab failing while the current file is read is 502, and nothing is committed", async () => {
    const w = await world();
    mock.inject({ method: "GET", path: /\/repository\/files\//, status: 500 });
    expect(await failure(w.run(bun))).toMatchObject({ code: "gitlab_failed", status: 502 });
    expect(w.commits()).toBe(0);
    expect(await w.mrs()).toEqual([]);
  });

  test("a repository with no default branch cannot take a pipeline", async () => {
    mock?.stop();
    const w = await world();
    const empty = mock.addProject({ path: "fx/empty", defaultBranch: null });
    const project = await createProject(t.db, {
      organizationId: w.org.id,
      name: "empty",
      gitlabProjectId: empty.id,
    });
    expect(
      await failure(applyPipeline(w.deps, w.org.id, project.id, CONNECTION, bun)),
    ).toMatchObject({ code: "no_default_branch" });
  });

  test("when the branch is already there with the right file, only the merge request is made", async () => {
    const w = await world();
    const text = render(catalog.find((c) => c.manifest.name === "bun-app") as Template);
    await w.api.repository.createBranch(w.remote.id, PIPELINE_BRANCH, "main");
    await w.api.repository.commitFiles(
      w.remote.id,
      { branch: PIPELINE_BRANCH, message: "earlier" },
      [{ action: "create", path: PIPELINE_FILE, content: text }],
    );
    const commits = w.commits();
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "opened", committed: false });
    expect(w.commits()).toBe(commits);
  });

  test("when the branch is there without the file, it is created on it", async () => {
    const w = await world();
    await w.api.repository.createBranch(w.remote.id, PIPELINE_BRANCH, "main");
    const r = await w.run(bun);
    expect(r).toMatchObject({ outcome: "opened", committed: true });
    expect(await w.file(PIPELINE_BRANCH)).toContain("Generated by orch");
  });
});

describe("previewPipeline", () => {
  test("shows the file, GitLab's verdict and what is there, and writes nothing", async () => {
    const mine = "stages: [mine]\nmine:\n  stage: mine\n  script: [echo hand written]\n";
    const w = await world({ [PIPELINE_FILE]: mine });
    const p = await previewPipeline(w.deps, w.org.id, w.project.id, bun);
    expect(p.existing).toBe("hand-written");
    expect(p.text).toContain("Generated by orch from template bun-app@1.0.0");
    expect(p.validation).toMatchObject({ ok: true, lint: { valid: true } });
    expect(p.template.name).toBe("bun-app");
    const writes = mock.requests.filter((r) => r.method !== "GET" && !r.path.endsWith("/ci/lint"));
    expect(writes).toEqual([]);
    expect(await w.file(PIPELINE_BRANCH)).toBeNull();
  });

  test("reports lint errors as a result, not an error", async () => {
    const w = await world();
    const p = await previewPipeline(w.deps, w.org.id, w.project.id, {
      ...bun,
      overrides: { broken: { stage: "check" } },
    });
    expect(p.validation.ok).toBe(false);
    expect(p.validation.lint.errors[0]).toContain("script");
  });
});
