import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createLogger, type Subject } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  getRun,
  getRunPlan,
  jobs,
  latestRunOfMergeRequest,
  listRuns,
  mergeRequestNotes,
  planPipelinesOfRun,
  storePlanSummary,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { githubForge } from "@orch/forge";
import { createGithubClient } from "@orch/github";
import { createMockGithub } from "@orch/github/mock";
import { APPLY_ENVIRONMENT, renderStackWorkflow, STACK_WORKFLOW_FILE } from "@orch/iac";
import { and, eq } from "drizzle-orm";
import { createApp } from "./app";
import { callerPrincipal } from "./credentials";
import { mrCommandHandler } from "./mr-commands";
import { mrPlanHandler } from "./mr-plan";
import { pipelineEventHandler, workerForge } from "./pipeline-runs";
import { runEventHandler } from "./run-ingest";
import { chain, type JobContext } from "./worker";

// FRG-32: a pull request on GitHub is planned when it is opened and again when its branch moves, and a comment applies
// it behind the environment's reviewers. Everything arrives as a signed delivery, goes through the receiver and is
// consumed by the same handlers the worker runs; GitHub is the mock, and the GitLab client must never be asked for.

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const TOKEN = "ghp_not-a-real-token-FRG32-CANARY-1234";
const SECRET = "whsec-frg32-CANARY-0123456789abcdef";

const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });
const sign = (body: string) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

const PLATFORM = { apiUrl: "https://orch.example.com", audience: "orch.example.com" };
// a stack that says nothing of its state keeps it on the platform (ADR-0017), so its jobs run an image with orch
const config = {
  ...PLATFORM,
  helperImage: "ghcr.io/example/orch-helper:1",
  images: { terraform: "registry.example.com/terraform-orch" },
};
const BACKEND = 'terraform {\n  backend "http" {}\n}\n';
const FILES: Record<string, string> = {
  "README.md": "# repository\n",
  [STACK_WORKFLOW_FILE]: renderStackWorkflow(PLATFORM),
  "stacks/net/stack.yml": "name: net\ntool: terraform\nversion: 1.9.0\n",
  "stacks/net/main.tf": BACKEND,
  "stacks/app/stack.yml": "name: app\ntool: terraform\nversion: 1.9.0\ndepends_on: [net]\n",
  "stacks/app/main.tf": BACKEND,
};
const TERRAFORM = [{ tag: "terraform" as const, confidence: "high" as const, evidence: ["a.tf"] }];
const REVIEWERS = {
  id: 1,
  type: "required_reviewers",
  reviewers: [{ type: "User", reviewer: { id: 9 } }],
};

let t: TestDb;
let hub: ReturnType<typeof createMockGithub>;
let app: ReturnType<typeof createApp>;
let forge: ReturnType<typeof githubForge>;
let org: string;
let connection: string;
let n = 0;
let edits = 0;
const responses: string[] = [];

const job = (payload: Record<string, unknown>): JobContext => ({
  id: "job",
  queue: WEBHOOK_QUEUE,
  payload,
  attempt: 1,
  maxAttempts: 5,
  log: logger,
  signal: new AbortController().signal,
});

// The GitLab client and the GitLab user lookup must never be used on behalf of a GitHub event.
const deps = () => ({
  db: t.db,
  gitlab: async (): Promise<never> => {
    throw new Error("a GitHub event must not open a GitLab client");
  },
  forge: workerForge({ db: t.db, keys, logger }),
  config,
  roles: async (): Promise<never> => {
    throw new Error("a GitHub commenter must not be looked up as a GitLab user");
  },
});
const consume = (payload: Record<string, unknown>) =>
  chain(
    mrPlanHandler(deps()),
    mrCommandHandler(deps()),
    pipelineEventHandler(deps()),
    runEventHandler(deps()),
  )(job(payload));

const allJobs = () => t.db.select().from(jobs).where(eq(jobs.queue, WEBHOOK_QUEUE));

/** Sends a signed delivery to the receiver, then runs each job it queued through the consumers, as the worker would. */
async function deliver(event: string, body: object) {
  const seen = new Set((await allJobs()).map((j) => j.id));
  const raw = JSON.stringify(body);
  const res = await app.handle(
    new Request(`http://localhost/webhooks/github/${connection}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(raw),
        "x-github-event": event,
        "x-github-delivery": crypto.randomUUID(),
      },
      body: raw,
    }),
  );
  responses.push(await res.text());
  expect(res.status).toBe(200);
  const fresh = (await allJobs()).filter((j) => !seen.has(j.id));
  for (const j of fresh) await consume(j.payload);
  return fresh.length;
}

beforeAll(async () => {
  t = await createTestDb();
  hub = createMockGithub({ token: TOKEN });
  org = (await createOrganization(t.db, { slug: "gh-mr", name: "One" })).id;
  connection = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "github",
      name: "hub",
      config: { baseUrl: hub.url },
      token: TOKEN,
      webhookSecret: SECRET,
    })
  ).id;
  forge = githubForge(
    createGithubClient({ baseUrl: hub.url, allowInsecureHttp: true, token: TOKEN, maxRetries: 0 }),
    { attempts: 3, delayMs: 0 },
  );
  const roles: Pick<Subject, "orgRoles" | "projectRoles"> = { orgRoles: {}, projectRoles: {} };
  app = createApp({
    logger,
    db: t.db,
    principal: callerPrincipal({ db: t.db, roles: () => roles }),
    ready: async () => {},
    keys,
  });
});
afterAll(async () => {
  hub.stop();
  await t.drop();
});

/** A repository with two stacks (`app` depends on `net`), its linked project, and a maintainer and a reader of it. */
async function world(opts: { gated?: boolean; files?: Record<string, string> } = {}) {
  const id = ++n;
  const name = `svc${id}`;
  const repo = hub.addRepo("acme", name, { files: opts.files ?? FILES });
  if (opts.gated) hub.addEnvironment("acme", name, APPLY_ENVIRONMENT, [REVIEWERS]);
  hub.protectBranch("acme", name, "main", { approvals: 1 });
  const maint = hub.addUser(`maint${id}`);
  hub.addCollaborator("acme", name, maint.login, "maintain");
  const reader = hub.addUser(`reader${id}`);
  hub.addCollaborator("acme", name, reader.login, "read");
  const stranger = hub.addUser(`stranger${id}`);
  const project = await createProject(t.db, {
    organizationId: org,
    name,
    gitlabProjectId: repo.id,
    connectionId: connection,
    detectedTypes: TERRAFORM,
  });
  const repository = { id: repo.id, full_name: `acme/${name}` };
  const w = {
    name,
    repo,
    project,
    maint,
    reader,
    stranger,
    /** A branch with one commit that edits `file`, and a pull request from it. */
    async open(file = "stacks/net/main.tf") {
      const branch = `feature-${++edits}`;
      await forge.repository.commitFiles(
        repo.id,
        { branch, startBranch: "main", message: `edit ${edits}` },
        [{ action: "update", path: file, content: `${BACKEND}# edit ${edits}\n` }],
      );
      const pr = await forge.mergeRequests.create(repo.id, {
        sourceBranch: branch,
        targetBranch: "main",
        title: "change",
      });
      return { branch, pr };
    },
    /** A new commit on the branch; returns the pull request as GitHub has it now. */
    async push(pull: { branch: string; pr: { iid: number } }) {
      await forge.repository.commitFiles(
        repo.id,
        { branch: pull.branch, message: `edit ${++edits}` },
        [{ action: "update", path: "stacks/net/main.tf", content: `${BACKEND}# edit ${edits}\n` }],
      );
      return forge.mergeRequests.get(repo.id, pull.pr.iid);
    },
    pullEvent: (
      pull: { branch: string; pr: { iid: number; sha: string | null } },
      action: string,
      over: { head?: object; sha?: string | null } = {},
    ) =>
      deliver("pull_request", {
        action,
        number: pull.pr.iid,
        repository,
        pull_request: {
          state: "open",
          head: {
            ref: pull.branch,
            sha: over.sha === undefined ? pull.pr.sha : over.sha,
            repo: { id: repo.id },
            ...over.head,
          },
          base: { ref: "main" },
        },
      }),
    say: (iid: number, login: string, body: string) => {
      const id = hub.addComment("acme", name, iid, login, body);
      return deliver("issue_comment", {
        action: "created",
        repository,
        issue: { number: iid, pull_request: {} },
        comment: { id },
      });
    },
    latest: (iid: number) => latestRunOfMergeRequest(t.db, org, project.id, iid),
    runs: async () => (await listRuns(t.db, org, project.id, { limit: 50 })).length,
    comments: (iid: number) => hub.comments("acme", name, iid),
    replies: (iid: number) =>
      hub
        .comments("acme", name, iid)
        .map((c) => c.body)
        .filter((b) => !b.startsWith("**orch plan**") && !b.startsWith("orch ")),
    dispatches: () =>
      hub.requests
        .filter(
          (r) =>
            r.method === "POST" &&
            r.path.startsWith(`/repos/acme/${name}/actions/workflows/`) &&
            r.path.endsWith("/dispatches"),
        )
        .map((r) => r.body as { ref: string; inputs: Record<string, string> }),
    cancels: () =>
      hub.requests
        .filter(
          (r) => r.method === "POST" && r.path.startsWith(`/repos/acme/${name}/actions/runs/`),
        )
        .filter((r) => r.path.endsWith("/cancel"))
        .map((r) => Number(r.path.split("/").at(-2))),
    audits: (action: string) =>
      t.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.projectId, project.id), eq(auditEvents.action, action))),
    /** The plan workflow succeeded and posted its summaries: each stack is `planned`, as the run events leave it. */
    async planDone(
      pull: { branch: string; pr: { iid: number; sha: string | null } },
      summaries = true,
    ) {
      const run = await w.latest(pull.pr.iid);
      if (!run) throw new Error("no run");
      const [pipeline] = await planPipelinesOfRun(t.db, org, project.id, run.id);
      if (pipeline === undefined) throw new Error("no plan pipeline");
      for (const s of run.stacks) {
        hub.setJob("acme", name, pipeline, `plan:${s.stack}`, {
          status: "completed",
          conclusion: "success",
        });
      }
      hub.setRun("acme", name, pipeline, { status: "completed", conclusion: "success" });
      await deliver("workflow_run", {
        action: "completed",
        repository,
        workflow_run: {
          id: pipeline,
          status: "completed",
          conclusion: "success",
          head_branch: pull.branch,
          head_sha: pull.pr.sha,
        },
      });
      // shortcut in the test: the plan job cannot post its summary before FRG-23 (Actions OIDC), so it is stored here
      for (const s of summaries ? run.stacks : []) {
        await storePlanSummary(t.db, org, project.id, run.id, s.stack, {
          add: 1,
          change: 0,
          destroy: 0,
          resources: [{ address: `x.${s.stack}`, actions: ["create"] }],
        });
      }
      return { run, pipeline };
    },
    approve: (iid: number) =>
      hub.addReview("acme", name, iid, { login: "approver", state: "APPROVED" }),
  };
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

describe("planning a pull request", () => {
  test("is done when it is opened: a run, a dispatched plan workflow, the plan kept for it, and one note", async () => {
    const w = await world();
    const pull = await w.open();
    await w.pullEvent(pull, "opened");

    const run = await w.latest(pull.pr.iid);
    expect(run?.ref).toBe(pull.branch);
    expect(run?.sha).toBe(pull.pr.sha as string);
    expect(run?.stacks.map((s) => s.stack).sort()).toEqual(["app", "net"]);
    expect(w.dispatches()).toEqual([
      { ref: pull.branch, inputs: { run_id: run?.id as string, action: "plan" } },
    ]);
    expect(await getRunPlan(t.db, org, w.project.id, run?.id as string, "plan")).toBeDefined();
    expect((await planPipelinesOfRun(t.db, org, w.project.id, run?.id as string)).length).toBe(1);
    // the one table note, which this platform keeps editing
    const notes = w.comments(pull.pr.iid).filter((c) => c.body.startsWith("**orch plan**"));
    expect(notes.length).toBe(1);
    expect(notes[0]?.body).toContain("`net`");

    // the same delivery again reads the same thing and finds the run made
    await w.pullEvent(pull, "opened");
    expect(await w.runs()).toBe(1);
    expect(w.dispatches().length).toBe(1);
  });

  test("is done again when the branch moves, and the plan workflow of the run it replaced is cancelled", async () => {
    const w = await world();
    const pull = await w.open();
    await w.pullEvent(pull, "opened");
    const first = await w.latest(pull.pr.iid);
    const [stale] = await planPipelinesOfRun(t.db, org, w.project.id, first?.id as string);

    const moved = await w.push(pull);
    await w.pullEvent(pull, "synchronize", { sha: moved.sha });

    const second = await w.latest(pull.pr.iid);
    expect(second?.id).not.toBe(first?.id);
    expect(second?.sha).toBe(moved.sha as string);
    expect(w.dispatches().length).toBe(2);
    expect(w.cancels()).toEqual([stale as number]);
    expect(
      (await getRun(t.db, org, w.project.id, first?.id as string))?.stacks.map((s) => s.status),
    ).toEqual(["canceled", "canceled"]);
  });

  test("is done again for a reopened pull request and for no other action", async () => {
    const w = await world();
    const pull = await w.open();
    for (const action of ["labeled", "edited", "closed", "assigned"]) {
      await w.pullEvent(pull, action);
    }
    expect(await w.runs()).toBe(0);
    await w.pullEvent(pull, "reopened");
    expect(await w.runs()).toBe(1);
  });

  test("is refused for a pull request from a fork, with nothing planned, sent or said", async () => {
    const w = await world();
    const pull = await w.open();
    await w.pullEvent(pull, "opened", { head: { repo: { id: w.repo.id + 1000 } } });
    // a fork whose repository was deleted has no head repository at all
    await w.pullEvent(pull, "synchronize", { head: { repo: null } });
    expect(await w.runs()).toBe(0);
    expect(w.dispatches()).toEqual([]);
    expect(w.comments(pull.pr.iid)).toEqual([]);
    expect(lines.join("\n")).toContain("pull request from a fork");
  });

  test("is refused when the source branch is not at this commit, whatever the delivery says", async () => {
    const w = await world();
    const pull = await w.open();
    await w.push(pull);
    // GitHub's own word is the pull request's commit; the branch has moved on from the commit it is read at
    const stale = (await forge.mergeRequests.get(w.repo.id, pull.pr.iid)).sha;
    await forge.repository.deleteBranch(w.repo.id, pull.branch);
    await w.pullEvent(pull, "synchronize", { sha: stale });
    expect(await w.runs()).toBe(0);
    expect(w.dispatches()).toEqual([]);
    expect(w.comments(pull.pr.iid).map((c) => c.body)).toEqual([
      expect.stringContaining("the source branch is not in this project at this commit"),
    ]);
  });

  test("that GitHub cannot run says why in the note and starts nothing", async () => {
    const w = await world({
      files: {
        ...FILES,
        "stacks/net/stack.yml": "name: net\ntool: terraform\nversion: 1.9.0\nenvironment: prod\n",
      },
    });
    const pull = await w.open();
    await w.pullEvent(pull, "opened");
    expect(await w.runs()).toBe(0);
    expect(w.dispatches()).toEqual([]);
    const [note] = w.comments(pull.pr.iid);
    expect(note?.body).toContain("The pipeline could not be generated:");
    expect(note?.body).toContain("net");
  });

  test("that GitHub would not dispatch leaves no run, says so in fixed words, and repeats nothing GitHub said", async () => {
    const w = await world();
    const pull = await w.open();
    hub.inject({
      method: "POST",
      path: `/repos/acme/${w.name}/actions/workflows/orch-stacks.yml/dispatches`,
      status: 422,
      times: 10,
      body: { message: `Workflow does not have 'workflow_dispatch' trigger ${TOKEN}` },
    });
    await w.pullEvent(pull, "opened");
    expect(await w.runs()).toBe(0);
    const [note] = w.comments(pull.pr.iid);
    expect(note?.body).toContain("GitHub could not start the workflow");
    expect(note?.body).not.toContain("workflow_dispatch");
    expect(note?.body).not.toContain(TOKEN);
  });

  test("never touches a project of another connection that has the same number", async () => {
    const w = await world();
    const other = await createConnection(t.db, keys, {
      organizationId: org,
      type: "gitlab",
      name: "lab",
      config: { baseUrl: "https://gitlab.test" },
      token: "glpat-not-for-github-1234",
    });
    const lookalike = await createProject(t.db, {
      organizationId: org,
      name: `lookalike${n}`,
      gitlabProjectId: w.repo.id,
      connectionId: other.id,
      detectedTypes: TERRAFORM,
    });
    const pull = await w.open();
    await w.pullEvent(pull, "opened");
    expect(await w.runs()).toBe(1);
    expect((await listRuns(t.db, org, lookalike.id, { limit: 10 })).length).toBe(0);
  });
});

/** A pull request opened, planned and with its plans done, approved, and `orch apply` allowed. */
async function ready(w: World) {
  const pull = await w.open();
  await w.pullEvent(pull, "opened");
  const done = await w.planDone(pull);
  w.approve(pull.pr.iid);
  return { pull, ...done };
}

describe("applying a pull request by comment", () => {
  test("starts the apply workflow behind the gate, as the commenter, and says so", async () => {
    const w = await world({ gated: true });
    const { pull, run } = await ready(w);
    expect((await getRun(t.db, org, w.project.id, run.id))?.stacks.map((s) => s.status)).toEqual([
      "planned",
      "planned",
    ]);

    await w.say(pull.pr.iid, w.maint.login, "orch apply");

    const now = await getRun(t.db, org, w.project.id, run.id);
    expect(now?.stacks.map((s) => s.status)).toEqual(["applying", "applying"]);
    const apply = w.dispatches().at(-1);
    expect(apply).toEqual({ ref: pull.branch, inputs: { run_id: run.id, action: "apply" } });
    // what the workflow reads: the commit, and what was judged of each stack
    const kept = (await getRunPlan(t.db, org, w.project.id, run.id, "apply")) as {
      sha: string;
      levels: { name: string; judged: { add: number } }[][];
    };
    expect(kept.sha).toBe(pull.pr.sha as string);
    expect(kept.levels.flat().map((s) => [s.name, s.judged.add])).toEqual([
      ["net", 1],
      ["app", 1],
    ]);
    expect(w.replies(pull.pr.iid)).toEqual(["Apply started for `app, net`."]);
    const [event] = await w.audits("run.apply");
    expect(event).toMatchObject({ actorKind: "github_user", actorId: String(w.maint.id) });
  });

  test("is refused with no reviewers on the apply environment: the stacks stay planned and nothing is sent", async () => {
    const w = await world();
    const { pull, run } = await ready(w);
    const before = w.dispatches().length;
    await w.say(pull.pr.iid, w.maint.login, "orch apply");
    expect((await getRun(t.db, org, w.project.id, run.id))?.stacks.map((s) => s.status)).toEqual([
      "planned",
      "planned",
    ]);
    expect(w.dispatches().length).toBe(before);
    expect(w.replies(pull.pr.iid)).toHaveLength(1);
    expect(w.replies(pull.pr.iid)[0]).toContain("Not applied:");
  });

  test("is refused when GitHub would not dispatch it: the stacks stay planned, nothing is kept for the apply, and nothing GitHub said is repeated", async () => {
    const w = await world({ gated: true });
    const { pull, run } = await ready(w);
    hub.inject({
      method: "POST",
      path: `/repos/acme/${w.name}/actions/workflows/orch-stacks.yml/dispatches`,
      status: 404,
      times: 10,
      body: { message: `Not Found ${TOKEN}` },
    });
    await w.say(pull.pr.iid, w.maint.login, "orch apply");
    expect((await getRun(t.db, org, w.project.id, run.id))?.stacks.map((s) => s.status)).toEqual([
      "planned",
      "planned",
    ]);
    expect(await getRunPlan(t.db, org, w.project.id, run.id, "apply")).toBeUndefined();
    expect(w.replies(pull.pr.iid)).toEqual([
      "Not applied: `GitHub would not start the apply workflow`",
    ]);
    expect(await w.audits("run.apply")).toEqual([]);
  });

  test("is refused for a stack whose plan was never summarised, since there is nothing judged to compare with", async () => {
    const w = await world({ gated: true });
    const pull = await w.open();
    await w.pullEvent(pull, "opened");
    const { run } = await w.planDone(pull, false);
    w.approve(pull.pr.iid);
    const before = w.dispatches().length;
    await w.say(pull.pr.iid, w.maint.login, "orch apply");
    expect((await getRun(t.db, org, w.project.id, run.id))?.stacks.map((s) => s.status)).toEqual([
      "planned",
      "planned",
    ]);
    expect(w.dispatches().length).toBe(before);
    expect(w.replies(pull.pr.iid)[0]).toContain("has no judged changes to apply");
  });

  test("is refused to a reader, who is told, and ignored from a stranger, who is not", async () => {
    const w = await world({ gated: true });
    const { pull, run } = await ready(w);
    await w.say(pull.pr.iid, w.reader.login, "orch apply");
    await w.say(pull.pr.iid, w.stranger.login, "orch apply");
    expect((await getRun(t.db, org, w.project.id, run.id))?.stacks.map((s) => s.status)).toEqual([
      "planned",
      "planned",
    ]);
    expect(w.replies(pull.pr.iid)).toEqual(["You are not allowed to apply this pull request."]);
    expect(await w.audits("run.apply")).toEqual([]);
  });

  test("fails the job when the commenter's role cannot be read, so that it is tried again", async () => {
    const w = await world({ gated: true });
    const { pull, run } = await ready(w);
    hub.inject({
      method: "GET",
      path: `/repos/acme/${w.name}/collaborators/${w.maint.login}/permission`,
      status: 500,
      times: 20,
    });
    await expect(w.say(pull.pr.iid, w.maint.login, "orch apply")).rejects.toBeDefined();
    expect((await getRun(t.db, org, w.project.id, run.id))?.stacks.map((s) => s.status)).toEqual([
      "planned",
      "planned",
    ]);
  });

  test("is not done for talk, an edited comment or a comment that is not one line", async () => {
    const w = await world({ gated: true });
    const { pull, run } = await ready(w);
    await w.say(pull.pr.iid, w.maint.login, "orch seems slow");
    await w.say(pull.pr.iid, w.maint.login, "orch apply\n/merge");
    const id = hub.addComment("acme", w.name, pull.pr.iid, w.maint.login, "orch apply");
    await deliver("issue_comment", {
      action: "edited",
      repository: { id: w.repo.id, full_name: `acme/${w.name}` },
      issue: { number: pull.pr.iid, pull_request: {} },
      comment: { id },
    });
    expect((await getRun(t.db, org, w.project.id, run.id))?.stacks.map((s) => s.status)).toEqual([
      "planned",
      "planned",
    ]);
    // only the unclear one is answered, in the words that fit GitHub
    expect(w.replies(pull.pr.iid)).toEqual([
      expect.stringContaining("That was not understood, so nothing was done."),
    ]);
  });

  test("does nothing for a comment on an issue that is not a pull request", async () => {
    const w = await world({ gated: true });
    const { pull } = await ready(w);
    const before = await allJobs();
    const raw = JSON.stringify({
      action: "created",
      repository: { id: w.repo.id, full_name: `acme/${w.name}` },
      issue: { number: pull.pr.iid },
      comment: { id: 1 },
    });
    const res = await app.handle(
      new Request(`http://localhost/webhooks/github/${connection}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(raw),
          "x-github-event": "issue_comment",
          "x-github-delivery": crypto.randomUUID(),
        },
        body: raw,
      }),
    );
    expect(res.status).toBe(200);
    expect((await allJobs()).length).toBe(before.length);
  });
});

describe("orch plan by comment", () => {
  test("plans a pull request no delivery planned, as the commenter", async () => {
    const w = await world();
    const pull = await w.open();
    await w.say(pull.pr.iid, w.maint.login, "orch plan");
    expect((await w.latest(pull.pr.iid))?.stacks.length).toBe(2);
    expect(w.replies(pull.pr.iid)).toEqual([
      "Planning started for the newest commit. The note above shows how it goes.",
    ]);
    const [created] = await w.audits("run.create");
    expect(created).toMatchObject({ actorKind: "github_user", actorId: String(w.maint.id) });
  });
});

describe("a stack that waits for approval", () => {
  test("is said in the pull request's note, with the page where a person approves", async () => {
    const w = await world({ gated: true });
    const { pull, run } = await ready(w);
    await w.say(pull.pr.iid, w.maint.login, "orch apply");
    const [apply] = (
      await t.db.query.runPipelines.findMany({ where: (p, { eq }) => eq(p.runId, run.id) })
    ).filter((p) => p.action === "apply");
    const id = apply?.gitlabPipelineId as number;
    // GitHub holds the first level's apply job for the environment's reviewers
    hub.setRun("acme", w.name, id, { status: "waiting" });
    hub.setJob("acme", w.name, id, "apply:net", { status: "waiting", conclusion: null });
    await deliver("workflow_job", {
      action: "waiting",
      repository: { id: w.repo.id, full_name: `acme/${w.name}` },
      workflow_job: { id: 1, run_id: id, name: "apply:net", status: "waiting", conclusion: null },
    });
    const url = (await getRun(t.db, org, w.project.id, run.id))?.stacks.find(
      (s) => s.stack === "net",
    )?.approvalUrl;
    expect(url).toMatch(/^http/);
    const note = w.comments(pull.pr.iid).find((c) => c.body.startsWith("**orch plan**"));
    expect(note?.body).toContain("waiting for approval in GitHub");
    expect(note?.body).toContain(url as string);
  });
});

test("no log line, audit event, stored note, response or comment holds the token or the webhook secret", async () => {
  const notes = await t.db.select().from(mergeRequestNotes);
  const audits = await t.db.select().from(auditEvents);
  const comments = [...Array(n).keys()].flatMap((i) =>
    Array.from({ length: 30 }, (_, k) => hub.comments("acme", `svc${i + 1}`, k + 1)),
  );
  const haystack = JSON.stringify([lines, notes, audits, responses, comments]);
  for (const needle of [TOKEN, SECRET]) expect(haystack).not.toContain(needle);
});
