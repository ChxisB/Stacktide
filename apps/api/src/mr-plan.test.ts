import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  allCostLimits,
  allPools,
  auditEvents,
  createConnection,
  createOrganization,
  createPolicySet,
  createPool,
  createProject,
  deleteCostLimit,
  deletePolicySet,
  deletePool,
  getRun,
  latestRunOfMergeRequest,
  listPolicySets,
  listRuns,
  planPipelinesOfRun,
  runOfPipeline,
  setCostLimit,
  updatePool,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab, type Gitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { and, eq } from "drizzle-orm";
import { mrPlanHandler } from "./mr-plan";
import type { JobContext, JobHandler } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let conn1: string;
const logger = createLogger({ level: "error", write: () => {} });

const client = () =>
  createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
const config = {
  apiUrl: "https://orch.example.com",
  audience: "orch.example.com",
  helperImage: "ghcr.io/example/orch-helper:1",
};
const handlerFor = (open: () => Gitlab = client): JobHandler =>
  mrPlanHandler({ db: t.db, gitlab: async () => open(), config });
let handler: JobHandler;

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  o1 = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  o2 = (await createOrganization(t.db, { slug: "two", name: "Two" })).id;
  conn1 = (
    await createConnection(t.db, keys, {
      organizationId: o1,
      type: "gitlab",
      name: "live",
      config: { baseUrl: mock.url },
      token: mock.token,
    })
  ).id;
  handler = handlerFor();
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

const job = (payload: Record<string, unknown>): JobContext => ({
  id: "job",
  queue: WEBHOOK_QUEUE,
  payload,
  attempt: 1,
  maxAttempts: 5,
  log: logger,
  signal: new AbortController().signal,
});

const BACKEND = 'terraform {\n  backend "http" {}\n}\n';
const FILES: Record<string, string> = {
  ".gitlab-ci.yml": "noop:\n  script: [echo]\n",
  "README.md": "# repository\n",
  "stacks/net/stack.yml": "name: net\ntool: terraform\nversion: 1.9.0\n",
  "stacks/net/main.tf": BACKEND,
  "stacks/app/stack.yml": "name: app\ntool: terraform\nversion: 1.9.0\ndepends_on: [net]\n",
  "stacks/app/main.tf": BACKEND,
};
const TERRAFORM = [{ tag: "terraform" as const, confidence: "high" as const, evidence: ["a.tf"] }];

let n = 0;
let edits = 0;
/** A repository with two stacks (`app` depends on `net`), a branch `feature` and a linked project. */
async function world(
  opts: {
    files?: Record<string, string>;
    /** What the import saw in the project; Terraform when left out. */
    detectedTypes?: NonNullable<Parameters<typeof createProject>[1]["detectedTypes"]>;
  } = {},
) {
  const id = ++n;
  const path = `mp/p${id}`;
  const gl = mock.addProject({ path, files: opts.files ?? FILES });
  const api = client();
  await api.repository.createBranch(gl.id, "feature", "main");
  const project = await createProject(t.db, {
    organizationId: o1,
    name: `p${id}`,
    gitlabProjectId: gl.id,
    detectedTypes: opts.detectedTypes ?? TERRAFORM,
  });
  const have = new Set(Object.keys(opts.files ?? FILES));
  /** A new commit on the branch: `file` changes (or is made) every time. */
  const change = (file: string, content?: string) => {
    const action = have.has(file) ? ("update" as const) : ("create" as const);
    have.add(file);
    return api.repository.commitFiles(gl.id, { branch: "feature", message: `edit ${++edits}` }, [
      {
        action,
        path: file,
        content: content ?? `${file.endsWith(".tf") ? BACKEND : "# text\n"}# edit ${edits}\n`,
      },
    ]);
  };
  const w = {
    gl,
    api,
    project,
    mr: undefined as unknown as Awaited<ReturnType<typeof api.mergeRequests.create>>,
    change,
    async open() {
      w.mr = await api.mergeRequests.create(gl.id, {
        sourceBranch: "feature",
        targetBranch: "main",
        title: "change",
      });
      return w.mr;
    },
    /** The merge request as GitLab has it now. */
    now: () => api.mergeRequests.get(gl.id, w.mr.iid),
    notes: () => mock.mrNotes(path, w.mr.iid),
    latest: () => latestRunOfMergeRequest(t.db, o1, project.id, w.mr.iid),
    runs: async () => (await listRuns(t.db, o1, project.id, { limit: 50 })).length,
    posts: () =>
      mock.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith(`/projects/${gl.id}/pipeline`),
      ).length,
  };
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

const event = (w: World, over: Record<string, unknown> = {}) => ({
  event: "merge_request",
  organizationId: o1,
  connectionId: conn1,
  projectId: w.gl.id,
  iid: w.mr?.iid,
  action: "open",
  state: "opened",
  sourceBranch: "feature",
  targetBranch: "main",
  sha: "0".repeat(40),
  ...over,
});
const handle = (w: World, over: Record<string, unknown> = {}, h = handler) =>
  h(job(event(w, over)));
/** A world whose merge request is open with `file` changed, and the event for it handled. */
async function planned(file = "stacks/net/main.tf", opts?: Parameters<typeof world>[0]) {
  const w = await world(opts);
  await w.change(file);
  await w.open();
  await handle(w);
  return w;
}
const traffic = () => mock.requests.length;
/** A commit's actions that make `n` independent stacks. */
const manyStacks = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const name = `s${String(i).padStart(3, "0")}`;
    return {
      action: "create" as const,
      path: `many/${name}/stack.yml`,
      content: `name: ${name}\ntool: terraform\nversion: 1.9.0\n`,
    };
  });

describe("planning a merge request", () => {
  test("plans the stacks the merge request touches and those that depend on them", async () => {
    const w = await world();
    await w.change("stacks/net/main.tf");
    await w.open();
    const mainBefore = (await w.api.repository.getBranch(w.gl.id, "main")).commitId;
    // the commit named in the event is not trusted: GitLab says what the head is
    await handle(w, { sha: "f".repeat(40) });

    const run = await w.latest();
    expect(run).toMatchObject({ ref: "feature", sha: w.mr.sha, mergeRequestIid: w.mr.iid });
    expect(run?.stacks.map((s) => [s.stack, s.status])).toEqual([
      ["app", "queued"],
      ["net", "queued"],
    ]);

    // one plan pipeline on the branch, which later events are matched to
    const pipelines = await planPipelinesOfRun(t.db, o1, w.project.id, run?.id as string);
    expect(pipelines).toHaveLength(1);
    const found = await runOfPipeline(t.db, o1, w.project.id, pipelines[0] as number);
    expect(found).toMatchObject({ action: "plan", run: { id: run?.id } });
    const pipeline = await w.api.pipelines.get(w.gl.id, pipelines[0] as number);
    expect(pipeline.ref).toBe("feature");

    // the child pipeline travels as a file variable: nothing is written to the repository
    const vars = mock.pipelineVariables(pipelines[0] as number) ?? [];
    expect(vars).toHaveLength(1);
    expect(vars[0]).toMatchObject({ key: "ORCH_CHILD_PIPELINE", type: "file" });
    const yaml = vars[0]?.value ?? "";
    for (const name of ["plan:net", "plan:app", "summary:net", "summary:app"]) {
      expect(yaml).toContain(name);
    }
    // the summary jobs post to this run, on the API the runners reach
    expect(yaml).toContain("ORCH_API_URL: https://orch.example.com\n");
    expect(yaml).toContain(
      `"$ORCH_API_URL/organizations/${o1}/projects/${w.project.id}/runs/${run?.id}/plan-summary"`,
    );
    expect((await w.api.repository.getBranch(w.gl.id, "main")).commitId).toBe(mainBefore);
    expect((await w.api.repository.getBranch(w.gl.id, "feature")).commitId).toBe(
      w.mr.sha as string,
    );

    // one note, naming the commit and each stack
    expect(w.notes()).toHaveLength(1);
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain(`Commit \`${w.mr.sha}\``);
    expect(body).toContain("| `net` | queued |");
    expect(body).toContain("| `app` | queued |");

    // a change by the platform on its own: recorded as a job's
    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, run?.id as string));
    expect(row).toMatchObject({
      action: "run.create",
      actorKind: "job",
      actorId: "job",
      organizationId: o1,
      projectId: w.project.id,
    });
    expect(row?.metadata).toMatchObject({
      ref: "feature",
      sha: w.mr.sha,
      mergeRequestIid: w.mr.iid,
    });
  });

  test("a stack no change reaches is not planned", async () => {
    const w = await planned("stacks/app/main.tf");
    expect((await w.latest())?.stacks.map((s) => s.stack)).toEqual(["app"]);
  });

  test("a repeat of the event, or an update that brings no new commit, plans nothing more", async () => {
    const w = await planned();
    const run = await w.latest();
    for (const action of ["open", "update", "update", "reopen"]) await handle(w, { action });
    expect(await w.runs()).toBe(1);
    expect((await w.latest())?.id).toBe(run?.id);
    expect(w.posts()).toBe(1);
    expect(w.notes()).toHaveLength(1);
  });

  test("events at the same moment plan once", async () => {
    const w = await world();
    await w.change("stacks/net/main.tf");
    await w.open();
    await Promise.all([handle(w), handle(w), handle(w)]);
    expect(await w.runs()).toBe(1);
    expect(w.posts()).toBe(1);
    expect(w.notes()).toHaveLength(1);
  });

  test("so do events for a new commit, once the merge request has been planned before", async () => {
    // the first event of a merge request is held up by the insert of its row; later ones only by the lock
    const w = await planned();
    await w.change("stacks/app/main.tf");
    await Promise.all(["update", "update", "update"].map((action) => handle(w, { action })));
    expect(await w.runs()).toBe(2);
    expect(w.posts()).toBe(2);
    expect(w.notes()).toHaveLength(1);
  });

  test("a merge request that touches no stack says so, and a later commit that does plans", async () => {
    const w = await world();
    await w.change("README.md");
    await w.open();
    await handle(w);
    expect(await w.runs()).toBe(0);
    expect(w.posts()).toBe(0);
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.body).toContain("No stack is affected by this commit.");

    await w.change("stacks/net/main.tf");
    await handle(w, { action: "update" });
    expect(await w.runs()).toBe(1);
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.body).not.toContain("No stack is affected");
    expect(w.notes()[0]?.body).toContain("| `net` | queued |");
  });
});

describe("a new commit", () => {
  test("stops the plan of the old one, and plans the new one in the same note", async () => {
    const w = await planned();
    const old = await w.latest();
    const [oldPipeline] = await planPipelinesOfRun(t.db, o1, w.project.id, old?.id as string);
    const child = mock.addDownstream(oldPipeline as number, "plan", ["plan:net", "plan:app"]);
    const noteId = w.notes()[0]?.id;
    const first = w.mr.sha;

    await w.change("stacks/app/main.tf");
    await handle(w, { action: "update" });

    const next = await w.latest();
    expect(next?.id).not.toBe(old?.id);
    expect(next?.sha).toBe((await w.now()).sha as string);
    expect(next?.sha).not.toBe(first);
    const stale = await getRun(t.db, o1, w.project.id, old?.id as string);
    expect(stale?.stacks.map((s) => [s.status, s.error])).toEqual([
      ["canceled", "superseded by a newer commit"],
      ["canceled", "superseded by a newer commit"],
    ]);
    // GitLab stops the old pipeline and the child it started
    expect((await w.api.pipelines.get(w.gl.id, oldPipeline as number)).status).toBe("canceled");
    expect((await w.api.pipelines.get(w.gl.id, child)).status).toBe("canceled");
    // the new run is untouched
    expect(next?.stacks.map((s) => s.status)).toEqual(["queued", "queued"]);

    // the one note, now about the new commit
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.id).toBe(noteId as number);
    expect(w.notes()[0]?.body).toContain(`Commit \`${next?.sha}\``);
    expect(w.notes()[0]?.body).not.toContain(`Commit \`${first}\``);

    const rows = await t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.resourceId, old?.id as string));
    expect(rows.map((r) => r.action).sort()).toEqual(["run.create", "run.supersede"]);
    expect(rows.find((r) => r.action === "run.supersede")).toMatchObject({
      actorKind: "job",
      projectId: w.project.id,
    });
  });

  test("a commit that changes nothing a stack reads still replaces the plan", async () => {
    const w = await planned();
    const old = await w.latest();
    await w.change("README.md");
    // the branch is compared with `main`, so the first change is still in the merge request: the new run is for it
    await handle(w, { action: "update" });
    const stale = await getRun(t.db, o1, w.project.id, old?.id as string);
    expect(stale?.stacks.every((s) => s.status === "canceled")).toBe(true);
    expect((await w.latest())?.id).not.toBe(old?.id);
  });

  test("failing to stop the old pipeline does not fail the event", async () => {
    const w = await planned();
    const old = await w.latest();
    await w.change("stacks/app/main.tf");
    mock.inject({ method: "POST", path: /\/cancel$/, status: 500, times: 5 });
    await handle(w, { action: "update" });
    const stale = await getRun(t.db, o1, w.project.id, old?.id as string);
    expect(stale?.stacks.every((s) => s.status === "canceled")).toBe(true);
    expect((await w.latest())?.id).not.toBe(old?.id);
  });
});

describe("what is not planned", () => {
  test("an event for a merge request that is not open, or of another kind", async () => {
    const w = await world();
    await w.change("stacks/net/main.tf");
    await w.open();
    const before = traffic();
    for (const action of ["close", "merge", "approved", "unapproval"]) await handle(w, { action });
    expect(traffic()).toBe(before);
    await w.api.mergeRequests.update(w.gl.id, w.mr.iid, { state: "closed" });
    await handle(w, { action: "update" });
    expect(await w.runs()).toBe(0);
    expect(w.notes()).toEqual([]);
  });

  test("an event that is not a merge request event, or has no merge request, is ignored", async () => {
    const w = await world();
    await w.change("stacks/net/main.tf");
    await w.open();
    const before = traffic();
    await handler(job({ ...event(w), event: "push" }));
    await handler(job({ ...event(w), iid: undefined }));
    await handler(job({ ...event(w), organizationId: "not-an-id" }));
    await handler(job({}));
    expect(traffic()).toBe(before);
  });

  test("a project that is not linked, is another organization's, or is not Terraform", async () => {
    const w = await world();
    await w.change("stacks/net/main.tf");
    await w.open();
    const others = [
      await world({ detectedTypes: [] }),
      await world({
        detectedTypes: [
          { tag: "node", confidence: "high", evidence: ["package.json"] },
          { tag: "docker", confidence: "high", evidence: ["Dockerfile"] },
        ],
      }),
    ];
    for (const other of others) {
      await other.change("stacks/net/main.tf");
      await other.open();
    }
    const before = traffic();
    await handle(w, { projectId: 987_654 });
    await handle(w, { organizationId: o2 });
    for (const other of others) await handle(other);
    expect(traffic()).toBe(before);
    for (const other of others) expect(await other.runs()).toBe(0);
    expect(await w.runs()).toBe(0);
  });

  test("a project the import saw Terragrunt in is planned like one with Terraform", async () => {
    const w = await planned("stacks/net/main.tf", {
      detectedTypes: [{ tag: "terragrunt", confidence: "high", evidence: ["terragrunt.hcl"] }],
    });
    expect(await w.runs()).toBe(1);
  });

  test("a merge request whose branch is not in this project at that commit (a fork)", async () => {
    const w = await planned();
    const old = await w.latest();
    await w.change("stacks/app/main.tf");
    const fork = handlerFor(() => {
      const real = client();
      return {
        ...real,
        repository: {
          ...real.repository,
          getBranch: async (...args: Parameters<typeof real.repository.getBranch>) => ({
            ...(await real.repository.getBranch(...args)),
            commitId: "e".repeat(40),
          }),
        },
      } as Gitlab;
    });
    await handle(w, { action: "update" }, fork);
    // nothing planned, nothing stopped, and the note says why
    expect((await w.latest())?.id).toBe(old?.id);
    expect((await w.latest())?.stacks.map((s) => s.status)).toEqual(["queued", "queued"]);
    expect(w.posts()).toBe(1);
    expect(w.notes()[0]?.body).toContain("Not planned: the source branch is not in this project");
    // the commit itself is planned when it is the branch's
    await handle(w, { action: "update" });
    expect((await w.latest())?.id).not.toBe(old?.id);
    expect(w.notes()[0]?.body).not.toContain("Not planned");
  });

  test("the audit event of a run lists its first stacks and how many there are", async () => {
    const w = await world();
    await w.api.repository.commitFiles(
      w.gl.id,
      { branch: "feature", message: "many" },
      manyStacks(30),
    );
    await w.open();
    await handle(w);
    const run = await w.latest();
    expect(run?.stacks).toHaveLength(30);
    const [row] = await t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "run.create"), eq(auditEvents.resourceId, run?.id as string)),
      );
    const listed = (row?.metadata as { stacks?: string[] } | undefined)?.stacks;
    expect(row?.metadata).toMatchObject({ stackCount: 30 });
    expect(listed).toEqual(
      (run?.stacks ?? [])
        .map((s) => s.stack)
        .sort()
        .slice(0, 20),
    );
  });

  test("more stacks than a run holds", async () => {
    const w = await world();
    await w.api.repository.commitFiles(
      w.gl.id,
      { branch: "feature", message: "many" },
      manyStacks(101),
    );
    await w.open();
    await handle(w);
    expect(await w.runs()).toBe(0);
    expect(w.posts()).toBe(0);
    expect(w.notes()[0]?.body).toContain("101 stacks are affected; a run plans at most 100.");
  });
});

describe("what goes wrong in the repository", () => {
  test("a stack file with errors is left out and named, in a code span", async () => {
    const w = await world();
    await w.change("stacks/net/main.tf");
    await w.api.repository.commitFiles(w.gl.id, { branch: "feature", message: "bad" }, [
      {
        action: "create",
        path: "stacks/bad/stack.yml",
        content: "name: [\n# @everyone [x](http://evil)\n",
      },
    ]);
    await w.open();
    await handle(w);
    expect((await w.latest())?.stacks.map((s) => s.stack)).toEqual(["app", "net"]);
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain("Stack files with errors were left out:");
    const line = body.split("\n").find((l) => l.startsWith("- `stacks/bad/stack.yml"));
    expect(line?.endsWith("`")).toBe(true);
    expect(line?.slice(3, -1)).not.toContain("`");
  });

  test("a merge request that breaks the stack it touches does not say that no stack is affected", async () => {
    const alone = {
      ...FILES,
      "stacks/app/stack.yml": "name: app\ntool: terraform\nversion: 1.9.0\n",
    };
    const w = await world({ files: alone });
    await w.change("stacks/net/stack.yml", "name: [\n");
    await w.open();
    await handle(w);
    expect(await w.runs()).toBe(0);
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain("Stack files with errors were left out:");
    expect(body).toContain("stacks/net/stack.yml");
    expect(body).not.toContain("No stack is affected");
  });

  test("a dependency on a stack that cannot be read plans nothing", async () => {
    const w = await world();
    await w.change("stacks/net/stack.yml", "name: [\n");
    await w.change("stacks/app/main.tf");
    await w.open();
    await handle(w);
    expect(await w.runs()).toBe(0);
    expect(w.posts()).toBe(0);
    expect(w.notes()[0]?.body).toContain("The stacks' dependencies cannot be planned:");
  });

  test("a notice with long stack files and long dependency problems still fits the note's column", async () => {
    // the column holds at most 1000 characters, and a notice is up to two lists of repository text
    const long = (tag: string, i: number) => `${tag}-${i}-${"x".repeat(50)}`;
    const w = await world({
      files: {
        ...FILES,
        "stacks/app/stack.yml": `name: app\ntool: terraform\nversion: 1.9.0\ndepends_on: [net, ${[
          1, 2, 3, 4, 5,
        ]
          .map((i) => long("missing", i))
          .join(", ")}]\n`,
      },
    });
    for (const i of [1, 2, 3, 4, 5]) {
      await w.change(`stacks/${long("broken", i)}${"y".repeat(60)}/stack.yml`, "name: [\n");
    }
    await w.change("stacks/app/main.tf");
    await w.open();
    await handle(w);
    expect(await w.runs()).toBe(0);
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain("Stack files with errors were left out:");
    expect(body).toContain("The stacks' dependencies cannot be planned:");
    expect(body).toContain("- and 2 more");
  });

  test("a stack the pipeline cannot be made for is named", async () => {
    const w = await world({
      files: { ...FILES, "stacks/net/stack.yml": "name: net\ntool: terraform\n" },
    });
    await w.change("stacks/net/main.tf");
    await w.open();
    await handle(w);
    expect(await w.runs()).toBe(0);
    expect(w.posts()).toBe(0);
    expect(w.notes()[0]?.body).toContain("The pipeline could not be generated:");
    expect(w.notes()[0]?.body).toContain("has no version");
  });
});

describe("what goes wrong in GitLab", () => {
  test("a refused pipeline leaves no run, says why, and is tried again with the next event", async () => {
    const files = { ...FILES };
    delete files[".gitlab-ci.yml"];
    const w = await world({ files });
    await w.change("stacks/net/main.tf");
    await w.open();
    await handle(w);
    expect(await w.runs()).toBe(0);
    expect(w.notes()[0]?.body).toContain("GitLab could not start the pipeline:");
    expect(w.notes()[0]?.body).toContain("Missing CI config file");

    await w.change(".gitlab-ci.yml", "noop:\n  script: [echo]\n");
    await handle(w, { action: "update" });
    expect(await w.runs()).toBe(1);
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.body).not.toContain("could not start");
  });

  test("an error that may pass leaves nothing behind, and the retry plans once", async () => {
    const w = await world();
    await w.change("stacks/net/main.tf");
    await w.open();
    mock.inject({ method: "POST", path: /\/pipeline$/, status: 500 });
    await expect(handle(w)).rejects.toThrow();
    expect(await w.runs()).toBe(0);
    expect(w.notes()).toEqual([]);
    await handle(w);
    expect(await w.runs()).toBe(1);
    expect(w.notes()).toHaveLength(1);
  });

  test("a failure to write the note rolls the run back, so that the retry starts clean", async () => {
    const w = await world();
    await w.change("stacks/net/main.tf");
    await w.open();
    mock.inject({ method: "POST", path: /\/notes$/, status: 500 });
    await expect(handle(w)).rejects.toThrow();
    // the pipeline GitLab started stays (it only reads); the platform has no record of it
    expect(await w.runs()).toBe(0);
    await handle(w);
    expect(await w.runs()).toBe(1);
    expect(w.notes()).toHaveLength(1);
  });

  test("an unreadable merge request is dropped when no retry could help, retried when one could", async () => {
    const w = await world();
    await w.change("stacks/net/main.tf");
    await w.open();
    await handle(w, { iid: 99_999 });
    mock.inject({ method: "GET", path: /\/merge_requests\/\d+$/, status: 401 });
    await handle(w);
    expect(await w.runs()).toBe(0);
    mock.inject({ method: "GET", path: /\/merge_requests\/\d+$/, status: 500 });
    await expect(handle(w)).rejects.toThrow();
    await handle(w);
    expect(await w.runs()).toBe(1);
  });
});

describe("policy in the plan", () => {
  const POLICY_IMAGE = "ghcr.io/example/orch-policy:1";
  const TAGGED = {
    ...FILES,
    "stacks/net/stack.yml": "name: net\ntool: terraform\nversion: 1.9.0\ntags: [prod]\n",
  };
  const SET = { name: "prod", source: "platform/policies", ref: "v1", path: "rego", tag: "prod" };
  const addSet = (organizationId = o1, over: Partial<typeof SET> = {}) =>
    createPolicySet(t.db, { organizationId, ...SET, ...over });
  afterEach(async () => {
    for (const org of [o1, o2]) {
      for (const set of await listPolicySets(t.db, org, { limit: 100 })) {
        await deletePolicySet(t.db, org, set.id);
      }
    }
  });
  const plannedWith = async (policyImage: string | undefined) => {
    const w = await world({ files: TAGGED });
    await w.change("stacks/net/main.tf");
    await w.open();
    await handle(
      w,
      {},
      mrPlanHandler({ db: t.db, gitlab: async () => client(), config: { ...config, policyImage } }),
    );
    return w;
  };
  const jobsOf = async (w: World) => {
    const run = await w.latest();
    const pipelines = await planPipelinesOfRun(t.db, o1, w.project.id, run?.id as string);
    const yaml = mock.pipelineVariables(pipelines[0] as number)?.[0]?.value ?? "";
    return {
      run,
      yaml,
      jobs: Bun.YAML.parse(yaml) as Record<string, { image?: { name: string }; script?: string[] }>,
    };
  };

  test("a stack with a set's tag has its summary job judge the plan and post to the run's policy route", async () => {
    await addSet();
    const w = await plannedWith(POLICY_IMAGE);
    const { run, jobs } = await jobsOf(w);
    const net = jobs["summary:net"];
    expect(net?.image?.name).toBe(POLICY_IMAGE);
    const script = (net?.script ?? []).join("\n");
    expect(script).toContain("conftest test");
    expect(script).toContain("platform%2Fpolicies/repository/archive.tar.gz?sha=v1");
    expect(script).toContain(
      `"$ORCH_API_URL/organizations/${o1}/projects/${w.project.id}/runs/${run?.id}/policy-verdict"`,
    );
    // a stack no set reaches is summarized as before
    expect(jobs["summary:app"]?.image?.name).toBe(config.helperImage);
    expect((jobs["summary:app"]?.script ?? []).join("\n")).not.toContain("conftest");
  });

  test("with no set, or only another organization's, nothing changes", async () => {
    const none = await plannedWith(POLICY_IMAGE);
    expect((await jobsOf(none)).yaml).not.toContain("conftest");
    await addSet(o2);
    const other = await plannedWith(POLICY_IMAGE);
    expect((await jobsOf(other)).yaml).not.toContain("conftest");
  });

  test("a stack that a set reaches is not planned without the image to judge it, and the note says so", async () => {
    await addSet();
    const w = await plannedWith(undefined);
    expect(await w.runs()).toBe(0);
    expect(w.posts()).toBe(0);
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain("The pipeline could not be generated:");
    expect(body).toContain("policy.image");
  });

  test("a set that could not be used in a job is not planned, and is named", async () => {
    // stored behind the route's back: the generator is the one place that checks what it puts in a shell
    await addSet(o1, { name: "bad", source: "a/b; rm -rf /" });
    const w = await plannedWith(POLICY_IMAGE);
    expect(await w.runs()).toBe(0);
    expect(w.posts()).toBe(0);
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain("policy set");
    expect(body).toContain("bad");
  });

  test("a drift check is not judged", async () => {
    // planRequest without sets, as stack-drift.ts calls it
    const { planRequest } = await import("./mr-plan");
    const req = planRequest(
      { ...config, policyImage: POLICY_IMAGE },
      { organizationId: o1, projectId: "p" },
      [],
      [],
      "r",
      [],
      [],
      [],
    );
    expect(req.policy).toBeUndefined();
  });
});

describe("a DNS zone in the plan (DNS-7)", () => {
  const ZONES = {
    ...FILES,
    "stacks/pruned/stack.yml":
      "name: pruned\ntool: dnscontrol\nversion: 5.5.0\ndns:\n  prune: true\n",
    "stacks/pruned/dnsconfig.js": "// zone\n",
    "stacks/kept/stack.yml": "name: kept\ntool: dnscontrol\nversion: 5.5.0\n",
    "stacks/kept/dnsconfig.js": "// zone\n",
  };

  test("the run keeps each zone's prune setting from the commit: true, false, and none for Terraform", async () => {
    const w = await world({ files: ZONES });
    for (const f of [
      "stacks/net/main.tf",
      "stacks/pruned/dnsconfig.js",
      "stacks/kept/dnsconfig.js",
    ])
      await w.change(f);
    await w.open();
    await handle(w);
    const run = await w.latest();
    const prune = Object.fromEntries((run?.stacks ?? []).map((s) => [s.stack, s.dnsPrune]));
    expect(prune).toEqual({ app: null, kept: false, net: null, pruned: true });
  });

  // DNS-12: a repository of only zones has no Terraform for the import to see
  test("a repo of only zones is planned when the import tagged it dnscontrol, and is left alone when it did not", async () => {
    const files = {
      ".gitlab-ci.yml": FILES[".gitlab-ci.yml"] as string,
      "zones/example/stack.yml": "name: example-com\ntool: dnscontrol\nversion: 5.5.0\n",
      "zones/example/dnsconfig.js": "// zone\n",
    };
    const tagged = await planned("zones/example/dnsconfig.js", {
      files,
      detectedTypes: [{ tag: "dnscontrol", confidence: "high", evidence: ["dnsconfig.js"] }],
    });
    expect(await tagged.runs()).toBe(1);
    expect((await tagged.latest())?.stacks.map((s) => s.stack)).toEqual(["example-com"]);
    const untagged = await planned("zones/example/dnsconfig.js", { files, detectedTypes: [] });
    expect(await untagged.runs()).toBe(0);
  });
});

describe("cost in the plan", () => {
  const COST_IMAGE = "ghcr.io/example/orch-cost:1";
  // `net` carries the tag; `app` (which depends on it, so is planned with it) does not
  const TAGGED = {
    ...FILES,
    "stacks/net/stack.yml": "name: net\ntool: terraform\nversion: 1.9.0\ntags: [prod]\n",
  };
  const limit = (tag: string | null, organizationId = o1) =>
    setCostLimit(t.db, {
      organizationId,
      tag,
      maxMonthlyDelta: 100,
      warnAt: null,
      currency: "USD",
    });
  afterEach(async () => {
    for (const org of [o1, o2]) {
      for (const l of await allCostLimits(t.db, org)) await deleteCostLimit(t.db, org, l.id);
    }
  });
  const plannedWith = async (costImage: string | undefined) => {
    const w = await world({ files: TAGGED });
    await w.change("stacks/net/main.tf");
    await w.open();
    await handle(
      w,
      {},
      mrPlanHandler({ db: t.db, gitlab: async () => client(), config: { ...config, costImage } }),
    );
    return w;
  };
  const jobsOf = async (w: World) => {
    const run = await w.latest();
    const pipelines = await planPipelinesOfRun(t.db, o1, w.project.id, run?.id as string);
    const yaml = mock.pipelineVariables(pipelines[0] as number)?.[0]?.value ?? "";
    return {
      yaml,
      jobs: Bun.YAML.parse(yaml) as Record<string, { image?: { name: string }; needs?: unknown[] }>,
    };
  };

  test("a stack a tag's limit reaches is estimated, and the stacks it does not reach are not", async () => {
    await limit("prod");
    const { jobs } = await jobsOf(await plannedWith(COST_IMAGE));
    expect(Object.keys(jobs).filter((j) => j.startsWith("estimate:"))).toEqual(["estimate:net"]);
    expect(jobs["estimate:net"]?.image?.name).toBe(COST_IMAGE);
    expect(jobs["summary:net"]?.needs).toHaveLength(2);
    expect(jobs["summary:app"]?.needs).toHaveLength(1);
  });

  test("the organization's own limit reaches every stack of the plan", async () => {
    await limit(null);
    const { jobs } = await jobsOf(await plannedWith(COST_IMAGE));
    expect(Object.keys(jobs).filter((j) => j.startsWith("estimate:"))).toEqual([
      "estimate:net",
      "estimate:app",
    ]);
  });

  test("with no limit, only another organization's, or one for a tag no stack has, nothing is estimated", async () => {
    expect((await jobsOf(await plannedWith(COST_IMAGE))).yaml).not.toContain("infracost");
    await limit(null, o2);
    expect((await jobsOf(await plannedWith(COST_IMAGE))).yaml).not.toContain("infracost");
    await limit("staging");
    expect((await jobsOf(await plannedWith(COST_IMAGE))).yaml).not.toContain("infracost");
  });

  test("with no image to estimate with, the plan is made without an estimate (its apply is denied, COST-3), and the note says why", async () => {
    await limit(null);
    const w = await plannedWith(undefined);
    expect(await w.runs()).toBe(1);
    expect((await jobsOf(w)).yaml).not.toContain("infracost");
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain("ORCH_COST_IMAGE");
    expect(body).toContain("- `net`");
    expect(body).toContain("- `app`");
  });

  test("the note about a missing image names only the stacks a limit reaches, and there is none when no limit does", async () => {
    await limit("prod");
    const body = (await plannedWith(undefined)).notes()[0]?.body ?? "";
    expect(body).toContain("ORCH_COST_IMAGE");
    expect(body).toContain("- `net`");
    expect(body).not.toContain("- `app`");
    await deleteCostLimit(t.db, o1, (await allCostLimits(t.db, o1))[0]?.id as string);
    expect((await plannedWith(undefined)).notes()[0]?.body ?? "").not.toContain("ORCH_COST_IMAGE");
  });

  test("an image that is not one is not planned, and the note says so", async () => {
    await limit(null);
    const w = await plannedWith("Not An Image");
    expect(await w.runs()).toBe(0);
    expect(w.posts()).toBe(0);
    const body = w.notes()[0]?.body ?? "";
    expect(body).toContain("The pipeline could not be generated:");
    expect(body).toContain("cost.image");
  });

  test("the run keeps the tags each stack had in the commit, whatever the limits are", async () => {
    const w = await plannedWith(COST_IMAGE);
    const run = await w.latest();
    expect(run?.stacks.map((s) => [s.stack, s.tags])).toEqual([
      ["app", []],
      ["net", ["prod"]],
    ]);
  });

  test("a drift check is not estimated", async () => {
    // planRequest without limits, as stack-drift.ts calls it
    const { planRequest } = await import("./mr-plan");
    const req = planRequest(
      { ...config, costImage: COST_IMAGE },
      { organizationId: o1, projectId: "p" },
      [],
      [],
      "r",
      [],
      [],
      [],
    );
    expect(req.cost).toBeUndefined();
  });
});

describe("worker pools in the plan", () => {
  const POOLED = {
    ...FILES,
    "stacks/net/stack.yml": "name: net\ntool: terraform\nversion: 1.9.0\npool: prod\n",
  };
  const pool = (organizationId: string, name: string, over: Record<string, unknown> = {}) =>
    t.db.transaction((tx) =>
      createPool(tx, { organizationId, name, tags: [`${name}-runner`], ...over }),
    );
  afterEach(async () => {
    for (const org of [o1, o2]) {
      const all = await allPools(t.db, org);
      // the default goes first: it cannot be deleted while it is one
      for (const p of all.filter((x) => x.isDefault)) {
        await t.db.transaction((tx) => updatePool(tx, org, p.id, { isDefault: false }));
      }
      for (const p of all) await t.db.transaction((tx) => deletePool(tx, org, p.id));
    }
  });
  const plannedIn = async (files: Record<string, string>) => {
    const w = await world({ files });
    await w.change("stacks/net/main.tf");
    await w.open();
    await handle(w);
    return w;
  };
  const tagsOf = async (w: World) => {
    const run = await w.latest();
    const pipelines = await planPipelinesOfRun(t.db, o1, w.project.id, run?.id as string);
    const yaml = mock.pipelineVariables(pipelines[0] as number)?.[0]?.value ?? "";
    const jobs = Bun.YAML.parse(yaml) as Record<string, { tags?: string[] }>;
    return Object.fromEntries(Object.entries(jobs).map(([name, j]) => [name, j.tags]));
  };

  test("a stack that names a pool, and one that falls to the default, run on their pools' runners", async () => {
    await pool(o1, "prod");
    await pool(o1, "dev", { isDefault: true });
    const tags = await tagsOf(await plannedIn(POOLED));
    expect(tags["plan:net"]).toEqual(["prod-runner"]);
    expect(tags["summary:net"]).toEqual(["prod-runner"]);
    // `app` names none: it takes the default
    expect(tags["plan:app"]).toEqual(["dev-runner"]);
  });

  test("another organization's pools are not this one's: its default does not reach a stack here", async () => {
    await pool(o2, "other", { isDefault: true });
    await pool(o1, "prod");
    const tags = await tagsOf(await plannedIn(POOLED));
    expect(tags["plan:net"]).toEqual(["prod-runner"]);
    expect(tags["plan:app"]).toBeUndefined();
  });

  test("with no pools the pipeline has no tags", async () => {
    const tags = await tagsOf(await plannedIn(FILES));
    expect(Object.values(tags).filter((x) => x !== undefined)).toEqual([]);
  });

  test("a stack that names a pool the organization lacks, or has switched off, is not planned and the note names it", async () => {
    const missing = await plannedIn(POOLED);
    expect(await missing.runs()).toBe(0);
    expect(missing.posts()).toBe(0);
    expect(missing.notes()[0]?.body).toContain("The pipeline could not be generated:");
    expect(missing.notes()[0]?.body).toContain("the organization does not have");
    await pool(o1, "prod", { enabled: false });
    const off = await plannedIn(POOLED);
    expect(await off.runs()).toBe(0);
    expect(off.notes()[0]?.body).toContain("which is disabled");
  });
});
