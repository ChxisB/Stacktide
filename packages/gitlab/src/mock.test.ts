import { afterEach, describe, expect, test } from "bun:test";
import { createGitlab, GitlabError, isFinished } from "./index";
import { createMockGitlab } from "./mock/server";

function setup(opts: Parameters<typeof createMockGitlab>[0] = {}) {
  const mock = createMockGitlab(opts);
  const api = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  return { mock, api };
}

const collect = async <T>(it: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

describe("mock server", () => {
  test("rejects a wrong token with 401, accepts either auth style", async () => {
    const { mock } = setup();
    const bad = createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: "wrong-token-123" },
      maxRetries: 0,
    });
    await expect(bad.projects.get(1).catch((e) => e.kind)).resolves.toBe("unauthorized");
    const oauth = createGitlab({ baseUrl: mock.url, auth: { type: "oauth", token: mock.token } });
    mock.addProject({ path: "g/p" });
    expect((await oauth.projects.get("g/p")).path).toBe("g/p");
    mock.stop();
  });

  test("lists projects in id order across pages (keyset-style Link headers)", async () => {
    const { mock, api } = setup({ maxPerPage: 2 });
    const ids = [1, 2, 3, 4, 5].map((i) => mock.addProject({ path: `g/p${i}` }).id);
    const listed = await collect(api.projects.list());
    expect(listed.map((p) => p.id)).toEqual(ids);
    expect(mock.requests.filter((r) => r.path === "/api/v4/projects")).toHaveLength(3);
    mock.stop();
  });

  test("idAfter resumes a listing after that id, across pages", async () => {
    const { mock, api } = setup({ maxPerPage: 2 });
    const ids = [1, 2, 3, 4, 5].map((i) => mock.addProject({ path: `g/p${i}` }).id);
    const rest = await collect(api.projects.list({ idAfter: ids[1] }));
    expect(rest.map((p) => p.id)).toEqual(ids.slice(2));
    expect(await collect(api.projects.list({ idAfter: ids[4] }))).toEqual([]);
    mock.stop();
  });

  test("filters by archived and search; an empty repository has no default branch", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/live" });
    mock.addProject({ path: "g/old", archived: true });
    mock.addProject({ path: "g/empty", defaultBranch: null });
    expect((await collect(api.projects.list({ archived: true }))).map((p) => p.path)).toEqual([
      "g/old",
    ]);
    expect((await collect(api.projects.list({ search: "liv" }))).map((p) => p.path)).toEqual([
      "g/live",
    ]);
    expect((await api.projects.get("g/empty")).defaultBranch).toBeNull();
    mock.stop();
  });
});

describe("a commit as a ref", () => {
  test("the commit a branch is at reads like the branch; one it moved on from is unknown", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p", files: { "a.txt": "one" } });
    await api.repository.createBranch("g/p", "feature", "main");
    const commit = (path: string) =>
      api.repository.commitFiles("g/p", { branch: "feature", message: "m" }, [
        { action: "create", path, content: path },
      ]);
    await commit("b.txt");
    const head = (await api.repository.getBranch("g/p", "feature")).commitId;
    const files = (ref: string) =>
      collect(api.repository.tree("g/p", { ref, recursive: true })).then((e) =>
        e.map((x) => x.path),
      );
    expect(await files(head)).toEqual(["a.txt", "b.txt"]);
    expect((await api.repository.getFile("g/p", "b.txt", head)).content).toBe("b.txt");
    expect((await api.repository.compare("g/p", "main", head)).files.map((f) => f.newPath)).toEqual(
      ["b.txt"],
    );

    // the mock keeps no history, so a commit the branch moved on from is unknown, like any other
    await commit("c.txt");
    for (const ref of [head, "f".repeat(40)]) {
      await expect(files(ref).catch((e) => e.kind)).resolves.toBe("not_found");
      await expect(api.repository.compare("g/p", "main", ref).catch((e) => e.kind)).resolves.toBe(
        "not_found",
      );
    }
    mock.stop();
  });
});

describe("merge request notes", () => {
  test("a test can read a merge request's notes and delete one, after which updating it is a 404", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    await api.repository.createBranch("g/p", "feature", "main");
    const mr = await api.mergeRequests.create("g/p", {
      sourceBranch: "feature",
      targetBranch: "main",
      title: "t",
    });
    const note = await api.mergeRequests.createNote("g/p", mr.iid, "first");
    await api.mergeRequests.updateNote("g/p", mr.iid, note.id, "second");
    expect(mock.mrNotes("g/p", mr.iid)).toEqual([{ id: note.id, body: "second" }]);
    mock.deleteMrNote("g/p", mr.iid, note.id);
    expect(mock.mrNotes("g/p", mr.iid)).toEqual([]);
    await expect(
      api.mergeRequests.updateNote("g/p", mr.iid, note.id, "third").catch((e) => e.kind),
    ).resolves.toBe("not_found");
    expect(() => mock.mrNotes("g/p", 99)).toThrow("no merge request 99");
    mock.stop();
  });

  test("a note reads back with its author: the token's for one it wrote, anyone's for one a test adds", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    await api.repository.createBranch("g/p", "feature", "main");
    const mr = await api.mergeRequests.create("g/p", {
      sourceBranch: "feature",
      targetBranch: "main",
      title: "t",
    });
    const own = await api.mergeRequests.createNote("g/p", mr.iid, "mine");
    expect(own.authorId).toBe(mock.tokenUser.id);
    const said = mock.addMrNote("g/p", mr.iid, { body: "orch plan", authorId: 42 });
    const system = mock.addMrNote("g/p", mr.iid, { body: "merged", authorId: 1, system: true });
    expect(await api.mergeRequests.getNote("g/p", mr.iid, said)).toEqual({
      id: said,
      body: "orch plan",
      system: false,
      authorId: 42,
    });
    expect((await api.mergeRequests.getNote("g/p", mr.iid, system)).system).toBe(true);
    const unsigned = mock.addMrNote("g/p", mr.iid, { body: "x" });
    expect((await api.mergeRequests.getNote("g/p", mr.iid, unsigned)).authorId).toBeNull();
    // a system note is not one a person wrote: the test helper for reading notes leaves it out
    expect(mock.mrNotes("g/p", mr.iid).map((n) => n.id)).toEqual([own.id, said, unsigned]);
    mock.deleteMrNote("g/p", mr.iid, said);
    await expect(api.mergeRequests.getNote("g/p", mr.iid, said).catch((e) => e.kind)).resolves.toBe(
      "not_found",
    );
    mock.stop();
  });
});

describe("merge request approval and merge status", () => {
  test("a merge request is not approved and is mergeable until a test says otherwise", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    await api.repository.createBranch("g/p", "feature", "main");
    const mr = await api.mergeRequests.create("g/p", {
      sourceBranch: "feature",
      targetBranch: "main",
      title: "t",
    });
    expect(mr.mergeStatus).toBe("mergeable");
    expect(await api.mergeRequests.approvals("g/p", mr.iid)).toEqual({ approved: false });

    mock.setMergeRequest("g/p", mr.iid, { approved: true, mergeStatus: "ci_still_running" });
    expect(await api.mergeRequests.approvals("g/p", mr.iid)).toEqual({ approved: true });
    expect((await api.mergeRequests.get("g/p", mr.iid)).mergeStatus).toBe("ci_still_running");
    // the approval state is not a field of the merge request itself
    expect(JSON.stringify(await api.mergeRequests.get("g/p", mr.iid))).not.toContain("approved");

    mock.setMergeRequest("g/p", mr.iid, { state: "merged" });
    expect((await api.mergeRequests.get("g/p", mr.iid)).state).toBe("merged");
    expect(() => mock.setMergeRequest("g/p", 99, { approved: true })).toThrow(
      "no merge request 99",
    );
    mock.stop();
  });

  test("approvals of a merge request that is not there are a 404", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    await expect(api.mergeRequests.approvals("g/p", 5).catch((e) => e.kind)).resolves.toBe(
      "not_found",
    );
    mock.stop();
  });
});

describe("pipelines", () => {
  const CI = 'build:\n  stage: build\n  script:\n    - "true"\ntest:\n  script:\n    - "true"\n';
  const ready = (opts: Parameters<typeof setup>[0] = {}) => {
    const s = setup(opts);
    s.mock.addProject({ path: "g/p", files: { ".gitlab-ci.yml": CI } });
    return s;
  };

  test("trigger variables reach GitLab but never come back or leak into errors", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main", [
      { key: "TOKEN", value: "super-secret-value" },
      { key: "CERT", value: "-----BEGIN-----", type: "file" },
    ]);
    expect(mock.pipelineVariables(p.id)).toEqual([
      { key: "TOKEN", value: "super-secret-value", type: "env_var" },
      { key: "CERT", value: "-----BEGIN-----", type: "file" },
    ]);
    const shown = JSON.stringify([
      p,
      await api.pipelines.get("g/p", p.id),
      await collect(api.pipelines.jobs("g/p", p.id)),
    ]);
    expect(shown).not.toContain("super-secret-value");
    mock.stop();
  });

  test("an error that echoes a trigger variable is scrubbed", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ message: "invalid value super-secret-value" }, { status: 400 }),
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    const err = await api.pipelines
      .trigger("g/p", "main", [{ key: "TOKEN", value: "super-secret-value" }])
      .catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(err.message).not.toContain("super-secret-value");
    server.stop(true);
  });

  test("jobs follow the CI file; retry restarts failed jobs, cancel stops unfinished ones", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main");
    expect(p.status).toBe("pending");
    expect((await collect(api.pipelines.jobs("g/p", p.id))).map((j) => j.stage)).toEqual([
      "build",
      "test",
    ]);

    mock.finishPipeline(p.id, "failed");
    expect((await api.pipelines.get("g/p", p.id)).status).toBe("failed");
    expect(isFinished((await api.pipelines.get("g/p", p.id)).status)).toBe(true);
    expect((await api.pipelines.retry("g/p", p.id)).status).toBe("pending");
    expect((await api.pipelines.cancel("g/p", p.id)).status).toBe("canceled");
    const jobs = await collect(api.pipelines.jobs("g/p", p.id));
    expect(jobs.every((j) => j.status === "canceled")).toBe(true);

    mock.finishPipeline(p.id, "success");
    expect((await api.pipelines.cancel("g/p", p.id)).status).toBe("success");
    expect((await api.pipelines.retry("g/p", p.id)).status).toBe("success");
    mock.stop();
  });

  test("one job can be played on its own, and its id and the pipeline's status are known", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main");
    const ids = mock.jobIds(p.id);
    expect(Object.keys(ids).sort()).toEqual(["build", "test"]);
    expect(mock.setJobStatus(p.id, "build", "running")).toBe(ids.build as number);
    mock.setJobStatus(p.id, "test", "failed", "stuck_or_timeout_failure");
    mock.setPipelineStatus(p.id, "running");
    const jobs = await collect(api.pipelines.jobs("g/p", p.id));
    expect(jobs.map((j) => [j.id, j.name, j.status, j.failureReason])).toEqual([
      [ids.build as number, "build", "running", null],
      [ids.test as number, "test", "failed", "stuck_or_timeout_failure"],
    ]);
    expect((await api.pipelines.get("g/p", p.id)).status).toBe("running");
    expect(() => mock.setJobStatus(p.id, "deploy", "running")).toThrow("no job deploy");
    expect(() => mock.jobIds(1)).toThrow("no pipeline 1");
    expect(() => mock.setPipelineStatus(1, "failed")).toThrow("no pipeline 1");
    mock.stop();
  });

  test("a job's artifact is read by its path; one that was never made, or another job's, is missing", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main");
    const ids = mock.jobIds(p.id);
    mock.addArtifact(p.id, "build", "reports/out.json", '{"a":1}');

    expect(
      await api.pipelines.artifact("g/p", ids.build as number, "reports/out.json", 100),
    ).toEqual({
      status: "ok",
      text: '{"a":1}',
    });
    expect(
      await api.pipelines.artifact("g/p", ids.build as number, "reports/none.json", 100),
    ).toEqual({
      status: "missing",
    });
    expect(
      await api.pipelines.artifact("g/p", ids.test as number, "reports/out.json", 100),
    ).toEqual({
      status: "missing",
    });
    expect(await api.pipelines.artifact("g/p", 1, "reports/out.json", 100)).toEqual({
      status: "missing",
    });
    // past the cap it is not read, and says so
    expect(await api.pipelines.artifact("g/p", ids.build as number, "reports/out.json", 3)).toEqual(
      {
        status: "too_large",
      },
    );
    expect(() => mock.addArtifact(1, "build", "x", "y")).toThrow("no pipeline 1");
    expect(() => mock.addArtifact(p.id, "deploy", "x", "y")).toThrow("no job deploy");
    mock.stop();
  });

  test("a stack's Terraform state is read by name: the newest text, none is missing, a long one is not read", async () => {
    const { mock, api } = ready();
    mock.addTerraformState("g/p", "net", '{"version":4}');
    expect(await api.terraformState.get("g/p", "net", 100)).toEqual({
      status: "ok",
      text: '{"version":4}',
    });
    expect(await api.terraformState.get("g/p", "dns", 100)).toEqual({ status: "missing" });
    expect(await api.terraformState.get("g/p", "net", 3)).toEqual({ status: "too_large" });
    mock.addTerraformState("g/p", "net", '{"version":4,"serial":2}'); // the next version replaces it
    expect(await api.terraformState.get("g/p", "net", 100)).toEqual({
      status: "ok",
      text: '{"version":4,"serial":2}',
    });
    // GitLab answers 404 for a project that is not there as for a state that is not: both are `missing`
    expect(await api.terraformState.get("g/none", "net", 100)).toEqual({ status: "missing" });
    expect(() => mock.addTerraformState("g/none", "net", "{}")).toThrow("no project g/none");
    mock.stop();
  });

  test("a state name is one path segment, whatever it holds", async () => {
    const { mock, api } = ready();
    mock.addTerraformState("g/p", "a/b", "x");
    expect(await api.terraformState.get("g/p", "a/b", 100)).toEqual({ status: "ok", text: "x" });
    mock.stop();
  });

  test("an artifact path cannot climb out of the job", async () => {
    const { mock, api } = ready();
    await expect(api.pipelines.artifact("g/p", 1, "../../variables", 100)).rejects.toThrow(
      TypeError,
    );
    mock.stop();
  });

  test("a parent pipeline lists the child pipelines its trigger jobs started, whose jobs are their own", async () => {
    const { mock, api } = ready();
    const parent = await api.pipelines.trigger("g/p", "main");
    expect(await collect(api.pipelines.bridges("g/p", parent.id))).toEqual([]);
    const child = mock.addDownstream(parent.id, "orch-run", ["plan:a", "summary:a"]);
    expect(await collect(api.pipelines.bridges("g/p", parent.id))).toEqual([
      { name: "orch-run", status: "pending", downstreamPipelineId: child },
    ]);
    const names = async (id: number) =>
      (await collect(api.pipelines.jobs("g/p", id))).map((j) => j.name);
    expect(await names(child)).toEqual(["plan:a", "summary:a"]);
    expect(await names(parent.id)).toEqual(["build", "test"]);
    mock.setPipelineStatus(child, "running");
    expect((await collect(api.pipelines.bridges("g/p", parent.id)))[0]?.status).toBe("running");
    expect(mock.pipelineVariables(child)).toEqual([]);
    expect(() => mock.addDownstream(1, "x", [])).toThrow("no pipeline 1");
    mock.stop();
  });

  test("a failed job says why, and stops saying so once it runs again or passes", async () => {
    const { mock, api } = ready();
    const p = await api.pipelines.trigger("g/p", "main");
    const reasons = async () =>
      (await collect(api.pipelines.jobs("g/p", p.id))).map((j) => j.failureReason);
    expect(await reasons()).toEqual([null, null]);

    mock.finishPipeline(p.id, "failed", "runner_system_failure");
    expect(await reasons()).toEqual(["runner_system_failure", "runner_system_failure"]);
    mock.finishPipeline(p.id, "failed");
    expect(await reasons()).toEqual(["script_failure", "script_failure"]);

    await api.pipelines.retry("g/p", p.id);
    expect(await reasons()).toEqual([null, null]);
    mock.finishPipeline(p.id, "failed");
    mock.finishPipeline(p.id, "success");
    expect(await reasons()).toEqual([null, null]);

    mock.finishPipeline(p.id, "failed", "script_failure", ["build"]);
    const jobs = await collect(api.pipelines.jobs("g/p", p.id));
    expect(jobs.map((j) => [j.name, j.status, j.failureReason])).toEqual([
      ["build", "success", null],
      ["test", "failed", "script_failure"],
    ]);
    mock.stop();
  });

  test("a status GitLab adds later reads as unknown instead of failing", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          id: 1,
          iid: 1,
          status: "frobnicating",
          ref: "main",
          sha: "a",
          web_url: "u",
        }),
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    const p = await api.pipelines.get("g/p", 1);
    expect(p.status).toBe("unknown");
    expect(isFinished(p.status)).toBe(false);
    server.stop(true);
  });

  test("a project without a CI file, or with a broken one, cannot start a pipeline", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/none" });
    mock.addProject({ path: "g/broken", files: { ".gitlab-ci.yml": "job:\n  stage: x\n" } });
    expect((await api.pipelines.trigger("g/none", "main").catch((e) => e)).kind).toBe("invalid");
    expect((await api.pipelines.trigger("g/broken", "main").catch((e) => e)).kind).toBe("invalid");
    mock.stop();
  });

  test("lint maps every kind of problem to a result with errors, never a throw", async () => {
    const { mock, api } = ready();
    for (const bad of [
      "",
      "- just\n- a list\n",
      "job: [unclosed\n",
      "job:\n  stage: x\n",
      "stages: [a]\n",
    ]) {
      const r = await api.ci.lint("g/p", bad);
      expect(r.valid).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
      expect(r.mergedYaml).toBeNull();
    }
    expect(await api.ci.lint("g/p", CI)).toMatchObject({ valid: true, errors: [] });
    mock.stop();
  });

  test("lint gives the configured warnings to valid config only", async () => {
    const { mock, api } = ready({ lintWarnings: ["jobs:build may allow multiple pipelines"] });
    expect(await api.ci.lint("g/p", CI)).toMatchObject({
      valid: true,
      warnings: ["jobs:build may allow multiple pipelines"],
    });
    expect((await api.ci.lint("g/p", "job:\n  stage: x\n")).warnings).toEqual([]);
    mock.stop();
  });

  describe("an include of one of GitLab's own templates", () => {
    const SCAN = "include:\n  - template: Jobs/Secret-Detection.gitlab-ci.yml\n";
    const lint = async (text: string) => {
      const { mock, api } = ready();
      const r = await api.ci.lint("g/p", text);
      mock.stop();
      return r.errors;
    };

    test("brings its job in the stage `test`, and the file's own keys win over it", async () => {
      expect(await lint(SCAN)).toEqual([]);
      expect(await lint(`${SCAN}secret_detection:\n  stage: check\nstages: [check]\n`)).toEqual([]);
      // a job of ours is not forced to have the template's script
      expect(await lint(`${SCAN}build:\n  tags: [big]\n`)).toEqual([
        "jobs:build config should implement the script:, run:, or trigger: keyword",
      ]);
    });

    test("a template GitLab does not have is an error, not a silent no-op", async () => {
      expect(
        await lint("include:\n  - template: Jobs/Nope.gitlab-ci.yml\nbuild:\n  script: [x]\n"),
      ).toEqual(["Included file `Jobs/Nope.gitlab-ci.yml` is empty or does not exist!"]);
    });

    test("a job in a stage the pipeline does not declare is refused, which is why a pipeline with its own stages moves the job", async () => {
      expect(await lint(`${SCAN}stages: [build]\nbuild:\n  stage: build\n  script: [x]\n`)).toEqual(
        [
          "jobs:secret_detection chosen stage does not exist; available stages are .pre, build, .post",
        ],
      );
      expect(await lint("build:\n  stage: nowhere\n  script: [x]\n")).toEqual([
        "jobs:build chosen stage does not exist; available stages are .pre, build, test, deploy, .post",
      ]);
    });
  });

  describe("an include of a file in another project", () => {
    const FILE = `spec:
  inputs:
    image:
      default: node:22
      options: [node:22, node:24]
    retries:
      type: number
      default: 2
    stage:
      type: string
---
build:
  image: $[[ inputs.image ]]
  stage: $[[ inputs.stage ]]
  retry: $[[ inputs.retries ]]
  script:
    - echo "on $[[ inputs.image ]]"
`;
    const withTemplates = (files: Record<string, string> = { "t/1/pipeline.yml": FILE }) => {
      const { mock, api } = setup();
      mock.addProject({ path: "g/templates", files });
      const p = mock.addProject({ path: "g/p" });
      return { mock, api, p };
    };
    const include = (extra = "", inputs = "      stage: test\n") =>
      `include:\n  - project: g/templates\n    file: t/1/pipeline.yml\n    inputs:\n${inputs}${extra}`;

    test("lints as the merged pipeline: inputs applied, the main file merged over the included jobs", async () => {
      const { mock, api, p } = withTemplates();
      expect(await api.ci.lint(p.id, include())).toMatchObject({ valid: true, errors: [] });
      // a job of the main file that has no script of its own takes the included one
      expect((await api.ci.lint(p.id, `${include()}build:\n  tags: [big]\n`)).valid).toBe(true);
      expect((await api.ci.lint(p.id, `${include()}other:\n  tags: [big]\n`)).errors).toEqual([
        "jobs:other config should implement the script:, run:, or trigger: keyword",
      ]);
      mock.stop();
    });

    test("says what is wrong with the include, as lint errors", async () => {
      const { mock, api, p } = withTemplates();
      const errors = async (text: string) => (await api.ci.lint(p.id, text)).errors;
      expect(await errors(include().replace("g/templates", "g/nope"))).toEqual([
        "Project `g/nope` not found or access denied! Make sure any includes in the pipeline configuration are correctly defined.",
      ]);
      expect(await errors(include().replace("t/1/", "t/2/"))).toEqual([
        "Project `g/templates` file `/t/2/pipeline.yml` does not exist!",
      ]);
      expect(await errors(include("    ref: gone\n"))).toEqual([
        "Project `g/templates` reference `gone` does not exist!",
      ]);
      expect(await errors(include("", ""))).toEqual([
        "`stage` input: required value has not been provided",
      ]);
      expect(await errors(include("      extra: 1\n"))).toEqual(["unknown input arguments: extra"]);
      expect((await errors(include("      image: node:18\n")))[0]).toContain(
        "not in the list of allowed options",
      );
      expect(await errors(include("      retries: '3'\n"))).toEqual([
        "`retries` input: provided value is not a number",
      ]);
      mock.stop();
    });

    test("a file that uses an input it does not declare is refused", async () => {
      const { mock, api, p } = withTemplates({
        "t/1/pipeline.yml": 'spec:\n  inputs: {}\n---\nbuild:\n  script: ["$[[ inputs.nope ]]"]\n',
      });
      expect((await api.ci.lint(p.id, include("", ""))).errors).toEqual([
        "unknown interpolation key: `nope`",
      ]);
      mock.stop();
    });

    test("the main file wins over the included file, and a leading slash in the path is allowed", async () => {
      const { mock, api } = withTemplates();
      mock.addProject({
        path: "g/thin",
        files: {
          ".gitlab-ci.yml": `${include().replace("file: t/", "file: /t/")}build:\n  stage: deploy\n`,
        },
      });
      const run = await api.pipelines.trigger("g/thin", "main");
      expect(
        (await collect(api.pipelines.jobs("g/thin", run.id))).map((j) => [j.name, j.stage]),
      ).toEqual([["build", "deploy"]]);
      mock.stop();
    });

    describe("a component of a catalog project", () => {
      let seq = 0;
      const comp = (name: string, stage: string) =>
        `spec:\n  inputs:\n    stage:\n      default: ${stage}\n---\n${name}:\n  stage: $[[ inputs.stage ]]\n  script:\n    - echo ${name}\n`;
      const use = (at: string, inputs = "") =>
        `include:\n  - component: $CI_SERVER_FQDN/g/catalog/${at}\n${inputs ? `    inputs:\n${inputs}` : ""}`;
      const world = async () => {
        const { mock, api } = setup();
        mock.addProject({
          path: "g/catalog",
          files: {
            "templates/one.yml": comp("uno", "test"),
            "templates/two/template.yml": comp("two", "test"),
          },
        });
        mock.addTag("g/catalog", "1.0.0", { "templates/one.yml": comp("one", "test") });
        mock.addTag("g/catalog", "1.2.0");
        const p = mock.addProject({ path: "g/p" });
        const lint = async (text: string) => (await api.ci.lint(p.id, text)).errors;
        return { mock, api, lint };
      };

      test("a release, a partial release, ~latest, a SHA and a branch each resolve to that snapshot of the project", async () => {
        const { mock, api, lint } = await world();
        const jobsAt = async (at: string) => {
          const thin = mock.addProject({
            path: `g/thin${++seq}`,
            files: { ".gitlab-ci.yml": use(at) },
          });
          const run = await api.pipelines.trigger(thin.id, "main");
          return (await collect(api.pipelines.jobs(thin.id, run.id))).map((j) => j.name);
        };
        // 1.0.0 has `one` alone; 1.2.0 and main also have `two` (the directory form) and `one` renamed `uno`
        expect(await lint(use("one@1.0.0"))).toEqual([]);
        expect(await lint(use("two@1.0.0"))).toEqual([
          "Component `g/catalog/two` does not exist at `1.0.0`",
        ]);
        expect(await lint(use("two@1.2.0"))).toEqual([]);
        for (const at of ["one@1", "one@1.2", "one@~latest", "one@main"])
          expect(await lint(use(at))).toEqual([]);
        expect(await lint(use("two@1"))).toEqual([]);
        expect(await lint(use("two@1.0"))).toEqual([
          "Component `g/catalog/two` does not exist at `1.0`",
        ]);
        const sha = mock.tagSha("g/catalog", "1.2.0");
        expect(await lint(use(`two@${sha}`))).toEqual([]);
        // a tag is a snapshot: later commits to the default branch do not change what it holds
        expect(await jobsAt("one@1.0.0")).toEqual(["one"]);
        expect(await jobsAt("one@1.2.0")).toEqual(["uno"]);
        mock.stop();
      });

      test("says what is wrong with the component, as lint errors", async () => {
        const { mock, lint } = await world();
        expect(await lint(use("one@1.0.0").replace("g/catalog", "g/nope"))).toEqual([
          "Project `g/nope` not found or access denied! Make sure any includes in the pipeline configuration are correctly defined.",
        ]);
        expect(await lint(use("one@9.9.9"))).toEqual([
          "Project `g/catalog` reference `9.9.9` does not exist!",
        ]);
        expect(await lint(use("none@1.0.0"))).toEqual([
          "Component `g/catalog/none` does not exist at `1.0.0`",
        ]);
        expect(await lint("include:\n  - component: just-a-name\n")).toEqual([
          "Component `just-a-name` is not of the form <fqdn>/<project>/<name>@<version>",
        ]);
        expect(await lint(use("one@1.0.0", "      stage: test\n      extra: 1\n"))).toEqual([
          "unknown input arguments: extra",
        ]);
        expect(await lint(use("one@1.0.0", "      stage: test\n"))).toEqual([]);
        mock.stop();
      });
    });

    test("an include that fails reports its own error and nothing about the main file's jobs", async () => {
      const { mock, api, p } = withTemplates();
      const broken = `${include().replace("t/1/", "t/2/")}build:\n  tags: [big]\n`;
      expect((await api.ci.lint(p.id, broken)).errors).toEqual([
        "Project `g/templates` file `/t/2/pipeline.yml` does not exist!",
      ]);
      mock.stop();
    });

    test("a pipeline of a project whose file only includes runs the included jobs", async () => {
      const { mock, api } = withTemplates();
      mock.addProject({ path: "g/thin", files: { ".gitlab-ci.yml": include() } });
      const run = await api.pipelines.trigger("g/thin", "main");
      expect((await collect(api.pipelines.jobs("g/thin", run.id))).map((j) => j.name)).toEqual([
        "build",
      ]);
      mock.stop();
    });
  });
});

describe("variables", () => {
  const owner = { project: "g/p" };
  const SECRET = "super-secret-value-9";
  const fakeGitlab = (handler: (req: Request) => Response) => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return handler(req);
      },
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    return { api, seen, stop: () => server.stop(true) };
  };

  test("a value is readable but does not show up in JSON, spread or Object.keys", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const v = await api.variables.create(owner, "API_TOKEN", { value: SECRET, masked: true });
    expect(v.value).toBe(SECRET);
    expect(JSON.stringify(v)).not.toContain(SECRET);
    expect(JSON.stringify({ ...v })).not.toContain(SECRET);
    expect(Object.keys(v)).not.toContain("value");
    expect(Bun.inspect(await collect(api.variables.list(owner)))).not.toContain(SECRET);
    mock.stop();
  });

  test("a hidden variable is masked and its value reads back as null", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const v = await api.variables.create(owner, "HIDDEN_ONE", { value: SECRET, hidden: true });
    expect(v).toMatchObject({ hidden: true, masked: true });
    expect(v.value).toBeNull();
    expect((await api.variables.get(owner, { key: "HIDDEN_ONE" })).value).toBeNull();
    const err = await api.variables
      .create(owner, "HIDDEN_TWO", { value: "short", hidden: true })
      .catch((e) => e);
    expect(err.kind).toBe("invalid");
    mock.stop();
  });

  test("group variables live apart from project variables", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("platform");
    mock.addProject({ path: "platform/p" });
    await api.variables.create({ group: group.id }, "SHARED", { value: "group-value-1" });
    expect(await collect(api.variables.list({ project: "platform/p" }))).toEqual([]);
    expect((await api.variables.get({ group: "platform" }, { key: "SHARED" })).value).toBe(
      "group-value-1",
    );
    expect(
      (await api.variables.get({ group: 2_000_000 }, { key: "SHARED" }).catch((e) => e)).kind,
    ).toBe("not_found");
    mock.stop();
  });

  test("lists across pages", async () => {
    const { mock, api } = setup({ maxPerPage: 2 });
    mock.addProject({ path: "g/p" });
    for (const k of ["A_1", "B_2", "C_3", "D_4", "E_5"]) {
      await api.variables.create(owner, k, { value: "plain" });
    }
    expect((await collect(api.variables.list(owner))).map((v) => v.key)).toEqual([
      "A_1",
      "B_2",
      "C_3",
      "D_4",
      "E_5",
    ]);
    mock.stop();
  });

  test("a bad key is refused before any request", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    for (const key of ["", "has space", "a/b", "a-b", "x".repeat(256), "../x"]) {
      await expect(api.variables.create(owner, key, { value: "v" })).rejects.toThrow(TypeError);
      await expect(api.variables.get(owner, { key })).rejects.toThrow(TypeError);
    }
    expect(mock.requests).toHaveLength(0);
    mock.stop();
  });

  test("an error that echoes a variable value is scrubbed, on create and on update", async () => {
    const f = fakeGitlab((req) =>
      req.method === "GET"
        ? Response.json({
            key: "K",
            value: "old-value-1",
            variable_type: "env_var",
            protected: false,
            masked: false,
            environment_scope: "*",
          })
        : Response.json({ message: `invalid value ${SECRET}` }, { status: 400 }),
    );
    const created = await f.api.variables.create(owner, "K", { value: SECRET }).catch((e) => e);
    const updated = await f.api.variables
      .update(owner, { key: "K" }, { value: SECRET })
      .catch((e) => e);
    for (const err of [created, updated]) {
      expect(err.kind).toBe("invalid");
      expect(err.message).toContain("[REDACTED]");
      expect(err.message).not.toContain(SECRET);
    }
    f.stop();
  });

  test("a lookup answered with another scope stops the write", async () => {
    const f = fakeGitlab(() =>
      Response.json({
        key: "K",
        value: "base",
        variable_type: "env_var",
        protected: false,
        masked: false,
        environment_scope: "*",
      }),
    );
    const ref = { key: "K", scope: "production" };
    expect((await f.api.variables.update(owner, ref, { value: "x" }).catch((e) => e)).kind).toBe(
      "not_found",
    );
    expect((await f.api.variables.delete(owner, ref).catch((e) => e)).kind).toBe("not_found");
    expect(f.seen.every((s) => s.startsWith("GET "))).toBe(true);
    f.stop();
  });

  test("a scope GitLab did not apply is reported, not hidden", async () => {
    const f = fakeGitlab(() =>
      Response.json(
        { key: "K", value: "v", variable_type: "env_var", protected: false, masked: false },
        { status: 201 },
      ),
    );
    const err = await f.api.variables
      .create({ group: 7 }, "K", { value: "v", scope: "production" })
      .catch((e) => e);
    expect(err.kind).toBe("unexpected");
    expect(err.message).toContain("production");
    f.stop();
  });

  test("create sends raw: true unless told otherwise", async () => {
    const sent: unknown[] = [];
    const f = fakeGitlab(() =>
      Response.json(
        { key: "K", value: "v", variable_type: "env_var", protected: false, masked: false },
        { status: 201 },
      ),
    );
    const rawFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return rawFetch(url, init);
    }) as typeof fetch;
    try {
      await f.api.variables.create(owner, "K", { value: "v" });
      await f.api.variables.create(owner, "K", { value: "v", raw: false });
    } finally {
      globalThis.fetch = rawFetch;
      f.stop();
    }
    expect(sent.map((b) => (b as { raw: boolean }).raw)).toEqual([true, false]);
  });

  test("a variable from an older GitLab without raw, hidden or scope fields still decodes", async () => {
    const f = fakeGitlab(() =>
      Response.json({
        key: "K",
        value: "v",
        variable_type: "env_var",
        protected: true,
        masked: false,
      }),
    );
    expect({ ...(await f.api.variables.get(owner, { key: "K" })) }).toEqual({
      key: "K",
      type: "env_var",
      protected: true,
      masked: false,
      hidden: false,
      raw: false,
      scope: "*",
      description: null,
    });
    f.stop();
  });
});

describe("failure injection", () => {
  const started: Array<{ stop: () => void }> = [];
  afterEach(() => {
    for (const m of started.splice(0)) m.stop();
  });
  const retrying = (maxRetries = 3) => {
    const mock = createMockGitlab();
    started.push(mock);
    const sleeps: number[] = [];
    const api = createGitlab({
      baseUrl: mock.url,
      auth: { type: "private-token", token: mock.token },
      maxRetries,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    mock.addProject({ path: "g/p" });
    return {
      mock,
      api,
      sleeps,
      hits: () => mock.requests.filter((r) => r.path.endsWith("/g%2Fp")),
    };
  };
  const projectGet = /\/projects\/[^/]+$/;

  test("a 429 waits for Retry-After and then succeeds", async () => {
    const { mock, api, sleeps, hits } = retrying();
    mock.inject({ method: "GET", path: projectGet, status: 429, times: 2, retryAfter: 2 });
    expect((await api.projects.get("g/p")).path).toBe("g/p");
    expect(sleeps).toEqual([2000, 2000]);
    expect(hits()).toHaveLength(3);
  });

  test("a wait beyond the cap fails at once as rate_limited, carrying the wait", async () => {
    const { mock, api, sleeps, hits } = retrying();
    mock.inject({ status: 429, times: 5, retryAfter: 120 });
    const err = await api.projects.get("g/p").catch((e) => e);
    expect(err).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 120_000 });
    expect(sleeps).toEqual([]);
    expect(hits()).toHaveLength(1);
  });

  test("a GET is retried through 500s and gives up after the limit", async () => {
    const ok = retrying();
    ok.mock.inject({ path: projectGet, status: 500, times: 2 });
    expect((await ok.api.projects.get("g/p")).path).toBe("g/p");
    expect(ok.hits()).toHaveLength(3);

    const down = retrying(2);
    down.mock.inject({ path: projectGet, status: 503, times: 99 });
    expect((await down.api.projects.get("g/p").catch((e) => e)).kind).toBe("server");
    expect(down.hits()).toHaveLength(3);
  });

  test("a POST is not retried after a 500, since it may have been applied", async () => {
    const { mock, api } = retrying();
    mock.inject({ method: "POST", status: 500, times: 3 });
    const err = await api.repository.createBranch("g/p", "feature", "main").catch((e) => e);
    expect(err.kind).toBe("server");
    expect(mock.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  test("an injection only hits what it matches and runs out", async () => {
    const { mock, api } = retrying(0);
    mock.inject({ method: "DELETE", status: 500 });
    mock.inject({ path: "/api/v4/groups", status: 500 });
    expect((await api.projects.get("g/p")).path).toBe("g/p"); // neither matches
    expect((await collect(api.groups.list()).catch((e) => e)).kind).toBe("server");
    expect(await collect(api.groups.list())).toEqual([]); // used up
  });
});

describe("the default-branch guard", () => {
  test("refuses before sending any commit request", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const err = await api.repository
      .commitFiles("g/p", { branch: "main", message: "m" }, [
        { action: "create", path: "x", content: "1" },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(GitlabError);
    expect(err.kind).toBe("invalid");
    expect(mock.requests.some((r) => r.method === "POST")).toBe(false);
    mock.stop();
  });
});

describe("the default-branch guard, spelling", () => {
  test("also catches a refs/heads/ prefixed default branch", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/p" });
    const err = await api.repository
      .commitFiles("g/p", { branch: "refs/heads/main", message: "m" }, [
        { action: "create", path: "x", content: "1" },
      ])
      .catch((e) => e);
    expect(err.kind).toBe("invalid");
    expect(mock.requests.some((r) => r.method === "POST")).toBe(false);
    mock.stop();
  });
});

describe("response validation", () => {
  test("a payload of the wrong shape names the fields, never the values", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({ id: "SECRET-VALUE-77", name: 5, path_with_namespace: "g/p", web_url: "u" }),
    });
    const api = createGitlab({
      baseUrl: `http://127.0.0.1:${server.port}`,
      auth: { type: "private-token", token: "glpat-0123456789" },
      maxRetries: 0,
    });
    const err = await api.projects.get(1).catch((e) => e);
    expect(err).toBeInstanceOf(GitlabError);
    expect(err.kind).toBe("unexpected");
    expect(err.message).toContain("id");
    expect(err.message).toContain("name");
    expect(err.message).not.toContain("SECRET-VALUE-77");
    server.stop(true);
  });

  test("encodes a full project path as one path segment", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "group/sub/repo" });
    await api.projects.get("group/sub/repo");
    expect(mock.requests.at(-1)?.path).toBe("/api/v4/projects/group%2Fsub%2Frepo");
    mock.stop();
  });
});

describe("members", () => {
  const level = (
    api: ReturnType<typeof setup>["api"],
    of: Parameters<ReturnType<typeof setup>["api"]["members"]["accessLevel"]>[0],
    user: number,
  ) => api.members.accessLevel(of, user);

  test("a direct membership is its level; a non-member is 0", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    const project = mock.addProject({ path: "acme/web" });
    mock.addMember({ group: group.id }, 11, 30);
    mock.addMember({ project: project.id }, 12, 20);
    expect(await level(api, { group: group.id }, 11)).toBe(30);
    expect(await level(api, { group: "acme" }, 11)).toBe(30);
    expect(await level(api, { project: project.id }, 12)).toBe(20);
    expect(await level(api, { project: "acme/web" }, 12)).toBe(20);
    expect(await level(api, { group: group.id }, 12)).toBe(0);
    expect(await level(api, { project: project.id }, 99)).toBe(0);
    mock.stop();
  });

  test("a project inherits the best level from its ancestor groups, nested ones included", async () => {
    const { mock, api } = setup();
    const top = mock.addGroup("acme");
    const sub = mock.addGroup("acme/platform");
    mock.addGroup("acmeish"); // a name that merely starts the same is no ancestor
    const project = mock.addProject({ path: "acme/platform/api" });
    const other = mock.addProject({ path: "acmeish/web" });
    mock.addMember({ group: top.id }, 21, 20);
    mock.addMember({ group: sub.id }, 22, 40);
    mock.addMember({ group: top.id }, 23, 50);
    mock.addMember({ project: project.id }, 23, 30);
    expect(await level(api, { project: project.id }, 21)).toBe(20);
    expect(await level(api, { group: sub.id }, 21)).toBe(20);
    expect(await level(api, { project: project.id }, 22)).toBe(40);
    expect(await level(api, { group: top.id }, 22)).toBe(0); // downwards only
    expect(await level(api, { project: project.id }, 23)).toBe(50); // the better of the two
    expect(await level(api, { project: other.id }, 21)).toBe(0);
    mock.removeMember({ group: top.id }, 21);
    expect(await level(api, { project: project.id }, 21)).toBe(0);
    mock.stop();
  });

  test("an invite awaiting approval, or a blocked account, holds nothing", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    mock.addUser({ id: 31, username: "ann", name: "Ann" });
    mock.addUser({ id: 32, username: "bob", name: "Bob", state: "blocked" });
    mock.addUser({ id: 33, username: "cy", name: "Cy", state: "deactivated" });
    mock.addMember({ group: group.id }, 31, 40);
    mock.addMember({ group: group.id }, 32, 40);
    mock.addMember({ group: group.id }, 33, 40);
    mock.addMember({ group: group.id }, 34, 40, "awaiting");
    expect(await level(api, { group: group.id }, 31)).toBe(40);
    expect(await level(api, { group: group.id }, 32)).toBe(0);
    expect(await level(api, { group: group.id }, 33)).toBe(0);
    expect(await level(api, { group: group.id }, 34)).toBe(0);
    mock.stop();
  });

  test("an answer that does not say the account is active grants nothing", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    mock.addMember({ group: group.id }, 41, 40);
    const real = globalThis.fetch;
    // GitLab leaving `state` out must not read as "active".
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const res = await real(input, init);
      if (!String(input instanceof Request ? input.url : input).includes("/members/all/"))
        return res;
      const { state: _state, ...rest } = (await res.json()) as Record<string, unknown>;
      return Response.json(rest);
    }) as typeof fetch;
    try {
      expect(await level(api, { group: group.id }, 41)).toBe(0);
    } finally {
      globalThis.fetch = real;
      mock.stop();
    }
  });

  test("a lookup that fails is an error, never 'no access'", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    mock.addMember({ group: group.id }, 51, 40);
    for (const [status, kind] of [
      [500, "server"],
      [403, "forbidden"],
      [401, "unauthorized"],
      [429, "rate_limited"],
    ] as const) {
      mock.inject({ path: /members\/all/, status });
      const error = await level(api, { group: group.id }, 51).catch((e) => e);
      expect(error).toBeInstanceOf(GitlabError);
      expect((error as GitlabError).kind).toBe(kind);
    }
    expect(await level(api, { group: group.id }, 51)).toBe(40);
    mock.stop();
  });

  test("a malformed answer is an error", async () => {
    const { mock, api } = setup();
    const group = mock.addGroup("acme");
    mock.addMember({ group: group.id }, 61, 40);
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
      const res = await real(input, init);
      if (!String(input instanceof Request ? input.url : input).includes("/members/all/"))
        return res;
      return Response.json({ access_level: "40", state: "active" });
    }) as typeof fetch;
    try {
      await expect(level(api, { group: group.id }, 61)).rejects.toThrow(GitlabError);
    } finally {
      globalThis.fetch = real;
      mock.stop();
    }
  });

  test("the token reports its scopes and expiry", async () => {
    const { mock, api } = setup({
      scopes: ["read_api", "read_user"],
      tokenExpiresAt: "2027-01-31",
    });
    expect(await api.users.tokenInfo()).toEqual({
      scopes: ["read_api", "read_user"],
      expiresAt: "2027-01-31",
    });
    mock.stop();
    const open = setup();
    expect(await open.api.users.tokenInfo()).toEqual({ scopes: ["api"], expiresAt: null });
    open.mock.stop();
  });

  test("the token's own user comes from /user", async () => {
    const { mock, api } = setup();
    expect(await api.users.current()).toEqual({
      gitlabId: mock.tokenUser.id,
      username: "mock-token-user",
      name: "Mock token user",
      active: true,
    });
    mock.stop();
  });
});

describe("tags", () => {
  test("lists the tags of a project, newest name first, and reads the tree and a file at a tag", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/catalog", files: { "templates/a.yml": "now\n" } });
    const first = mock.addTag("g/catalog", "1.0.0", { "templates/a.yml": "then\n" });
    mock.addTag("g/catalog", "1.2.0");
    mock.addTag("g/catalog", "1.10.0", { "templates/b.yml": "b\n" });

    const tags = await collect(api.repository.tags("g/catalog"));
    expect(tags.map((t) => t.name)).toEqual(["1.2.0", "1.10.0", "1.0.0"]);
    expect(tags.find((t) => t.name === "1.0.0")?.commitId).toBe(first);

    expect((await api.repository.getFile("g/catalog", "templates/a.yml", "1.0.0")).content).toBe(
      "then\n",
    );
    expect((await api.repository.getFile("g/catalog", "templates/a.yml", "1.2.0")).content).toBe(
      "now\n",
    );
    expect((await api.repository.getFile("g/catalog", "templates/a.yml", first)).content).toBe(
      "then\n",
    );
    const paths = async (ref: string) =>
      (await collect(api.repository.tree("g/catalog", { ref, path: "templates" }))).map(
        (e) => e.path,
      );
    expect(await paths("1.10.0")).toEqual(["templates/b.yml"]);
    expect(await paths("1.2.0")).toEqual(["templates/a.yml"]);

    await expect(collect(api.repository.tags("g/none"))).rejects.toMatchObject({
      kind: "not_found",
    });
    mock.stop();
  });

  test("a project without tags lists none", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/plain" });
    expect(await collect(api.repository.tags("g/plain"))).toEqual([]);
    mock.stop();
  });

  test("access tokens: a rotation ends the old secret at once and expires in a week unless told", async () => {
    const { mock, api } = setup();
    mock.addProject({ path: "g/tok" });
    const first = await api.accessTokens.create("g/tok", {
      name: "ci",
      scopes: ["api"],
      expiresAt: "2999-01-01",
    });
    expect(mock.accessTokenValid(first.token as string)).toBe(true);
    const second = await api.accessTokens.rotate("g/tok", first.id);
    expect(mock.accessTokenValid(first.token as string)).toBe(false);
    expect(mock.accessTokenValid(second.token as string)).toBe(true);
    const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    expect(second.expiresAt).toBe(week);
    // GitLab will not rotate what is revoked
    await expect(api.accessTokens.rotate("g/tok", first.id)).rejects.toMatchObject({
      kind: "invalid",
    });
    // a revoked token stays revoked, and a second revoke is no error
    await api.accessTokens.revoke("g/tok", second.id);
    await api.accessTokens.revoke("g/tok", second.id);
    expect(mock.accessTokenValid(second.token as string)).toBe(false);
    // an expired date is not valid either
    const old = await api.accessTokens.create("g/tok", {
      name: "old",
      scopes: ["api"],
      expiresAt: "2000-01-01",
    });
    expect(old.active).toBe(false);
    expect(mock.accessTokenValid(old.token as string)).toBe(false);
    // a malformed date is refused
    await expect(
      api.accessTokens.rotate("g/tok", old.id, { expiresAt: "tomorrow" }),
    ).rejects.toMatchObject({ kind: "invalid" });
    mock.stop();
  });
});
