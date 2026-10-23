import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, DomainError } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  approveChangeRequest,
  auditEvents,
  createApplyRequest,
  createConnection,
  createEnvironment,
  createOrganization,
  createProject,
  latestRunOfMergeRequest,
  listRuns,
  moveRunStack,
  recordStackJobs,
  runPipelines,
  setEnvironmentProtection,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { and, eq } from "drizzle-orm";
import { mrCommandHandler, parseCommand } from "./mr-commands";
import type { Roles } from "./session";
import type { JobContext, JobHandler } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let o1: string;
let o2: string;
let conn1: string;
const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });

const client = () =>
  createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });

// GitLab users and what they hold: a developer (may plan), a maintainer (may apply too), a
// reporter, someone with no role, and the owner of another organization.
const DEV = 1001;
const MAINT = 1002;
const REPORTER = 1003;
const NOBODY = 1004;
const STRANGER = 1005;
const held = (): Record<number, Roles> => ({
  [DEV]: { orgRoles: { [o1]: "member" }, projectRoles: {} },
  [MAINT]: { orgRoles: { [o1]: "admin" }, projectRoles: {} },
  [REPORTER]: { orgRoles: { [o1]: "viewer" }, projectRoles: {} },
  [STRANGER]: { orgRoles: { [o2]: "owner" }, projectRoles: {} },
});
let roleLookups: number[] = [];
let rolesFail = false;
const roles = async (user: { gitlabId: number }): Promise<Roles> => {
  roleLookups.push(user.gitlabId);
  if (rolesFail) throw new DomainError("membership_unavailable", 503, "GitLab is away");
  return held()[user.gitlabId] ?? { orgRoles: {}, projectRoles: {} };
};

const config = {
  apiUrl: "https://orch.example.com",
  audience: "orch.example.com",
  helperImage: "ghcr.io/example/orch-helper:1",
};
let handler: JobHandler;

beforeAll(async () => {
  t = await createTestDb();
  handler = mrCommandHandler({ db: t.db, gitlab: async () => client(), roles, config });
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
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

const BACKEND = 'terraform {\n  backend "http" {}\n}\n';
const FILES: Record<string, string> = {
  ".gitlab-ci.yml": '"apply:net":\n  script: [echo]\n"apply:app":\n  script: [echo]\n',
  "stacks/net/stack.yml": "name: net\ntool: terraform\nversion: 1.9.0\n",
  "stacks/net/main.tf": BACKEND,
  "stacks/app/stack.yml": "name: app\ntool: terraform\nversion: 1.9.0\ndepends_on: [net]\n",
  "stacks/app/main.tf": BACKEND,
};
const TERRAFORM = [{ tag: "terraform" as const, confidence: "high" as const, evidence: ["a.tf"] }];

let n = 0;
/** A linked Terraform project with an open, approved merge request that changes the `net` stack. */
async function world(detectedTypes = TERRAFORM, files: Record<string, string> = FILES) {
  const id = ++n;
  const path = `mc/p${id}`;
  const gl = mock.addProject({ path, files });
  const api = client();
  await api.repository.createBranch(gl.id, "feature", "main");
  await api.repository.commitFiles(gl.id, { branch: "feature", message: "edit" }, [
    { action: "update", path: "stacks/net/main.tf", content: `${BACKEND}# edit\n` },
  ]);
  const project = await createProject(t.db, {
    organizationId: o1,
    name: `p${id}`,
    gitlabProjectId: gl.id,
    detectedTypes,
  });
  const mr = await api.mergeRequests.create(gl.id, {
    sourceBranch: "feature",
    targetBranch: "main",
    title: "change",
  });
  mock.setMergeRequest(path, mr.iid, { approved: true });
  const said = new Set<number>();
  const w = {
    gl,
    project,
    mr,
    path,
    /** Someone writes a note; the webhook's job for it. Returns the job's context. */
    note(body: string, authorId: number | undefined, o: { system?: boolean } = {}) {
      const noteId = mock.addMrNote(path, mr.iid, { body, authorId, system: o.system ?? false });
      said.add(noteId);
      return w.job(noteId);
    },
    job(noteId: number, over: Record<string, unknown> = {}): JobContext {
      return {
        id: "job-9",
        queue: WEBHOOK_QUEUE,
        payload: {
          event: "note",
          organizationId: o1,
          connectionId: conn1,
          projectId: gl.id,
          noteableType: "MergeRequest",
          mrIid: mr.iid,
          noteId,
          ...over,
        },
        attempt: 1,
        maxAttempts: 5,
        log: logger,
        signal: new AbortController().signal,
      };
    },
    /** What has been written so far is no longer news to `replies`. */
    forget() {
      for (const x of mock.mrNotes(path, mr.iid)) said.add(x.id);
    },
    /** Says it and lets the worker handle it. */
    async say(body: string, authorId: number | undefined) {
      await handler(w.note(body, authorId));
    },
    /** What the platform wrote besides the merge request's one table note. None of it may be taken for a command. */
    replies() {
      const out = mock
        .mrNotes(path, mr.iid)
        .filter((x) => !said.has(x.id) && !x.body.startsWith("**orch plan**"))
        .map((x) => x.body);
      for (const r of out) {
        expect(parseCommand(r)).toBeUndefined();
        expect(r.split("\n").some((l) => l.trimStart().startsWith("/"))).toBe(false);
      }
      return out;
    },
    latest: () => latestRunOfMergeRequest(t.db, o1, project.id, mr.iid),
    runs: async () => (await listRuns(t.db, o1, project.id, { limit: 50 })).length,
    posts: () =>
      mock.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith(`/projects/${gl.id}/pipeline`),
      ).length,
    audits: (action: string) =>
      t.db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, action), eq(auditEvents.projectId, project.id))),
    /** The plan pipeline reports both stacks planned, as the ingest does. */
    async planned() {
      const run = await w.latest();
      if (!run) throw new Error("no run");
      let job = 600;
      for (const s of run.stacks) {
        await moveRunStack(t.db, o1, project.id, run.id, s.stack, "queued", "planning");
        await moveRunStack(t.db, o1, project.id, run.id, s.stack, "planning", "planned");
        await recordStackJobs(t.db, o1, project.id, run.id, s.stack, { planJobId: ++job });
      }
    },
    states: async () =>
      Object.fromEntries(((await w.latest())?.stacks ?? []).map((s) => [s.stack, s.status])),
  };
  return w;
}
type World = Awaited<ReturnType<typeof world>>;
/** A world whose merge request has been planned by a developer's command. */
async function plannedWorld() {
  const w = await world();
  await w.say("orch plan", DEV);
  await w.planned();
  w.forget();
  return w;
}

describe("what is a command", () => {
  const commands: [string, unknown][] = [
    ["orch plan", { name: "plan" }],
    ["orch apply", { name: "apply" }],
    ["orch apply net", { name: "apply", stack: "net" }],
    ["orch apply my-stack-2", { name: "apply", stack: "my-stack-2" }],
    ["  orch apply net  \n", { name: "apply", stack: "net" }],
    ["orch apply net\r\n", { name: "apply", stack: "net" }],
  ];
  for (const [text, expected] of commands) {
    test(`${JSON.stringify(text)} is ${JSON.stringify(expected)}`, () => {
      expect(parseCommand(text)).toEqual(expected as never);
    });
  }

  // meant for us, but not exactly one command: nothing may run (a second line may be a quick action)
  const unclear = [
    "orch apply net app",
    "orch apply Net",
    "orch apply  net",
    "orch plan net",
    "orch apply\n/merge",
    "orch apply net\n/merge",
    "orch plan\n\norch apply",
    "ORCH APPLY",
    "Orch plan",
    "orch\tapply",
    "orch apply /merge",
    "orch apply ../x",
    "orch apply net;ls",
    "orch apply -net",
    "orch apply net-",
    `orch apply ${"a".repeat(64)}`,
    "orch apply-all",
    "orch plan please",
    "orch apply ‮net",
  ];
  for (const text of unclear) {
    test(`${JSON.stringify(text)} is unclear`, () => {
      expect(parseCommand(text)).toBe("unclear");
    });
  }

  // not for us: talk, a quick action GitLab runs itself, or words that only contain ours
  const talk = [
    "",
    "   ",
    "looks good",
    "orch seems slow today",
    "orchestrate apply",
    "please orch apply",
    "`orch apply`",
    "> orch apply",
    "/orch apply",
    "/apply",
    "/merge",
    "/approve\norch apply",
    "orch applying",
    "orch",
  ];
  for (const text of talk) {
    test(`${JSON.stringify(text)} is not for us`, () => {
      expect(parseCommand(text)).toBeUndefined();
    });
  }
});

describe("orch plan", () => {
  test("a developer's command plans the newest commit as them, and says so", async () => {
    const w = await world();
    await w.say("orch plan", DEV);
    const run = await w.latest();
    expect(run?.stacks.map((s) => s.stack).sort()).toEqual(["app", "net"]);
    expect(w.posts()).toBe(1);
    expect(w.replies()).toEqual([
      "Planning started for the newest commit. The note above shows how it goes.",
    ]);
    const [created] = await w.audits("run.create");
    expect(created).toMatchObject({ actorKind: "gitlab_user", actorId: String(DEV) });
    // the merge request's one table note is there too
    expect(mock.mrNotes(w.path, w.mr.iid).some((x) => x.body.startsWith("**orch plan**"))).toBe(
      true,
    );
  });

  test("again, for a commit that has a run, plans nothing more", async () => {
    const w = await world();
    await w.say("orch plan", DEV);
    await w.say("orch plan", MAINT);
    expect(await w.runs()).toBe(1);
    expect(w.posts()).toBe(1);
    expect(w.replies()[1]).toContain("Nothing new was planned");
  });

  test("a developer may; a reporter, someone with no role and another organization's owner may not, and only the reporter is told", async () => {
    for (const [who, told] of [
      [REPORTER, true],
      [NOBODY, false],
      [STRANGER, false],
    ] as const) {
      const w = await world();
      lines.length = 0;
      await w.say("orch plan", who);
      expect(await w.runs()).toBe(0);
      expect(w.posts()).toBe(0);
      expect(w.replies()).toEqual(told ? ["You are not allowed to plan this merge request."] : []);
      expect(await w.audits("run.create")).toEqual([]);
      expect(lines.join("\n")).toContain("merge request command refused");
    }
  });

  test("a new commit is planned over the old run, and the replaced run is superseded as the person who asked", async () => {
    const w = await world();
    await w.say("orch plan", DEV);
    const first = await w.latest();
    await client().repository.commitFiles(w.gl.id, { branch: "feature", message: "more" }, [
      { action: "update", path: "stacks/net/main.tf", content: `${BACKEND}# more\n` },
    ]);
    await w.say("orch plan", MAINT);
    const second = await w.latest();
    expect(second?.id).not.toBe(first?.id);
    const [superseded] = await w.audits("run.supersede");
    expect(superseded).toMatchObject({
      actorKind: "gitlab_user",
      actorId: String(MAINT),
      resourceId: first?.id,
    });
  });

  test("without the settings plans need, it says so and plans nothing", async () => {
    const w = await world();
    const bare = mrCommandHandler({ db: t.db, gitlab: async () => client(), roles });
    await bare(w.note("orch plan", DEV));
    expect(await w.runs()).toBe(0);
    expect(w.replies()).toEqual([
      "Merge requests are not planned on this installation: it is not set up for it.",
    ]);
  });
});

describe("orch apply", () => {
  test("a maintainer's command applies the saved plans as them, audits the note, and says which stacks", async () => {
    const w = await plannedWorld();
    await w.say("orch apply", MAINT);
    expect(await w.states()).toEqual({ app: "applying", net: "applying" });
    expect(w.posts()).toBe(2); // the plan, and the apply
    expect(w.replies().at(-1)).toBe("Apply started for `app, net`.");
    const run = await w.latest();
    const [applied] = await w.audits("run.apply");
    expect(applied).toMatchObject({
      actorKind: "gitlab_user",
      actorId: String(MAINT),
      resourceId: run?.id,
    });
    expect(applied?.metadata).toMatchObject({ via: "note", when: "command" });
    const meta = applied?.metadata as { noteId?: unknown } | null;
    expect(typeof meta?.noteId).toBe("number");
  });

  test("a named stack applies only that one", async () => {
    const w = await plannedWorld();
    await w.say("orch apply net", MAINT);
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
    expect(w.replies().at(-1)).toBe("Apply started for `net`.");
  });

  test("a stack that is not in the run is refused, and nothing starts", async () => {
    const w = await plannedWorld();
    await w.say("orch apply nope", MAINT);
    expect(await w.states()).toEqual({ app: "planned", net: "planned" });
    expect(w.posts()).toBe(1);
    expect(w.replies().at(-1)).toBe('Not applied: `This run has no stack named "nope"`');
    expect(await w.audits("run.apply")).toEqual([]);
  });

  test("a stack of a protected environment waits for an approved request (GOV-3), and the reply says so", async () => {
    const w = await world(TERRAFORM, {
      ...FILES,
      "stacks/net/stack.yml": `${FILES["stacks/net/stack.yml"]}environment: prod\n`,
    });
    // a stack plans with the variables of the environment it names: that needs an image with orch
    const withImages = mrCommandHandler({
      db: t.db,
      gitlab: async () => client(),
      roles,
      config: { ...config, images: { terraform: "ghcr.io/example/terraform-orch" } },
    });
    const env = await createEnvironment(t.db, {
      organizationId: o1,
      projectId: w.project.id,
      name: "Prod",
      slug: "prod",
    });
    await setEnvironmentProtection(t.db, o1, w.project.id, env.id, true);
    await withImages(w.note("orch plan", DEV));
    await w.planned();
    w.forget();
    await w.say("orch apply net", MAINT);
    expect(w.replies().at(-1)).toContain("Not applied:");
    expect(w.replies().at(-1)).toContain("prod");
    expect(await w.states()).toEqual({ app: "planned", net: "planned" });
    expect(w.posts()).toBe(1);

    const run = await w.latest();
    const planJobId = run?.stacks.find((s) => s.stack === "net")?.planJobId;
    if (!run || !planJobId) throw new Error("net was not planned");
    const at = { organizationId: o1, projectId: w.project.id, environmentId: env.id };
    const made = await createApplyRequest(t.db, {
      ...at,
      kind: "iac_apply",
      subject: { runId: run.id, stacks: { net: planJobId } },
      diff: [{ action: "apply", key: "net" }],
      author: { kind: "user", id: "bob", ref: "user:bob" },
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await approveChangeRequest(t.db, keys, at, made.id, {
      kind: "user",
      id: "alice",
      ref: "user:alice",
    });
    w.forget();
    await w.say("orch apply net", MAINT);
    expect(w.replies().at(-1)).toBe("Apply started for `net`.");
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
  });

  test("a stack whose state is on the platform is applied by the command with the platform's address (STATE-5)", async () => {
    const w = await world(TERRAFORM, {
      ...FILES,
      "stacks/net/stack.yml": `${FILES["stacks/net/stack.yml"]}state: orch\n`,
    });
    const images = { terraform: "ghcr.io/example/terraform-orch" };
    const withImages = mrCommandHandler({
      db: t.db,
      gitlab: async () => client(),
      roles,
      images, // the worker gives both: the plan reads the config's, the apply the handler's
      config: { ...config, images },
    });
    await withImages(w.note("orch plan", DEV));
    await w.planned();
    w.forget();
    await withImages(w.note("orch apply net", MAINT));
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
    const run = await w.latest();
    const [pipeline] = await t.db
      .select()
      .from(runPipelines)
      .where(and(eq(runPipelines.runId, run?.id as string), eq(runPipelines.action, "apply")));
    const yaml = mock.pipelineVariables(pipeline?.gitlabPipelineId as number)?.[0]?.value ?? "";
    const jobs = Bun.YAML.parse(yaml) as Record<
      string,
      { script: string[]; variables: Record<string, string> }
    >;
    expect(jobs["apply:net"]?.script).toContain('login="$(orch ci login --state)"');
    expect(jobs["apply:net"]?.variables.ORCH_API_URL).toBe("https://orch.example.com");
  });

  test("whatever else refuses an apply is said in the reply", async () => {
    const w = await plannedWorld();
    await w.say("orch apply app", MAINT); // depends on net, which is not applied
    expect(w.replies().at(-1)).toContain('Not applied: `Stack "app" depends on "net"');
    mock.setMergeRequest(w.path, w.mr.iid, { approved: false });
    await w.say("orch apply net", MAINT);
    expect(w.replies().at(-1)).toBe("Not applied: `The merge request is not approved`");
    expect(await w.states()).toEqual({ app: "planned", net: "planned" });
  });

  test("a developer, a reporter, someone with no role and another organization's owner may not apply, and only those who can read are told", async () => {
    for (const [who, told] of [
      [DEV, true],
      [REPORTER, true],
      [NOBODY, false],
      [STRANGER, false],
    ] as const) {
      const w = await plannedWorld();
      lines.length = 0;
      await w.say("orch apply", who);
      expect(await w.states()).toEqual({ app: "planned", net: "planned" });
      expect(w.posts()).toBe(1);
      expect(w.replies()).toEqual(told ? ["You are not allowed to apply this merge request."] : []);
      expect(await w.audits("run.apply")).toEqual([]);
      expect(lines.join("\n")).toContain("merge request command refused");
    }
  });

  test("a merge request nobody has planned has nothing to apply", async () => {
    const w = await world();
    await w.say("orch apply", MAINT);
    expect(w.replies()).toEqual(["Nothing to apply: this merge request has not been planned."]);
    expect(w.posts()).toBe(0);
  });

  test("the same command twice starts one apply: the second finds the stacks claimed", async () => {
    const w = await plannedWorld();
    await w.say("orch apply", MAINT);
    await w.say("orch apply", MAINT);
    expect(w.posts()).toBe(2);
    expect(w.replies().at(-1)).toContain("Not applied:");
    expect((await w.audits("run.apply")).length).toBe(1);
  });

  test("a failed reply does not undo or repeat the apply", async () => {
    const w = await plannedWorld();
    // the client does not retry here, so one failure is the whole reply
    mock.inject({ method: "POST", path: /\/notes$/, status: 500, times: 1 });
    await w.say("orch apply", MAINT);
    expect(await w.states()).toEqual({ app: "applying", net: "applying" });
    expect(lines.some((l) => l.includes("could not reply to a merge request command"))).toBe(true);
    expect((await w.audits("run.apply")).length).toBe(1);
  });
});

describe("notes that are not commands", () => {
  async function untouched(w: World, run: () => Promise<void>, lookups = 0) {
    roleLookups = [];
    await run();
    expect(roleLookups.length).toBe(lookups);
    expect(w.posts()).toBe(1);
    expect(w.replies()).toEqual([]);
    expect(await w.states()).toEqual({ app: "planned", net: "planned" });
  }

  test("quick actions and talk are ignored without asking who wrote them", async () => {
    const w = await plannedWorld();
    for (const text of ["/orch apply", "/apply", "/merge", "looks good", "please orch apply"]) {
      await untouched(w, () => w.say(text, MAINT));
    }
  });

  test("a command with anything else in the note changes nothing, and only a reader is told", async () => {
    const w = await plannedWorld();
    for (const text of [
      "orch apply\n/merge",
      "orch apply net app",
      "ORCH APPLY",
      "orch plan net",
    ]) {
      roleLookups = [];
      await w.say(text, MAINT);
      expect(roleLookups).toEqual([MAINT]);
      expect(await w.states()).toEqual({ app: "planned", net: "planned" });
      expect(w.posts()).toBe(1);
    }
    const told = w.replies();
    expect(told.length).toBe(4);
    for (const r of told) expect(r).toContain("That was not understood, so nothing was done");
    // someone who may not even read is not answered
    const quiet = await plannedWorld();
    await quiet.say("orch apply net app", NOBODY);
    expect(quiet.replies()).toEqual([]);
  });

  test("a note whose author GitLab does not say is nobody's", async () => {
    const w = await plannedWorld();
    await untouched(w, () => w.say("orch apply", undefined));
  });

  test("a note GitLab wrote is not a person's", async () => {
    const w = await plannedWorld();
    await untouched(w, () => handler(w.note("orch apply", MAINT, { system: true })));
  });

  test("an edit is not run again: only a note being written is a command", async () => {
    const w = await plannedWorld();
    await untouched(w, async () => {
      const edited = w.note("orch apply", MAINT);
      await handler({ ...edited, payload: { ...edited.payload, action: "update" } });
    });
    // while a note that says it was created, or says nothing, is one
    const made = w.note("orch apply net", MAINT);
    await handler({ ...made, payload: { ...made.payload, action: "create" } });
    expect(await w.states()).toEqual({ app: "planned", net: "applying" });
  });

  test("only a merge request's note is one", async () => {
    const w = await plannedWorld();
    await untouched(w, async () => {
      const issue = w.note("orch apply", MAINT);
      await handler({ ...issue, payload: { ...issue.payload, noteableType: "Issue" } });
      await handler({ ...issue, payload: { ...issue.payload, mrIid: undefined } });
      await handler({ ...issue, payload: { ...issue.payload, noteId: "4" } });
      await handler({ ...issue, payload: { ...issue.payload, event: "merge_request" } });
    });
  });

  test("a project that is not seen to hold Terraform is left alone", async () => {
    const w = await world([]);
    await w.say("orch plan", DEV);
    expect(roleLookups.at(-1)).not.toBe(DEV);
    expect(await w.runs()).toBe(0);
    expect(w.replies()).toEqual([]);
  });

  test("the platform's own reply is not a command, so there is no loop", async () => {
    const w = await plannedWorld();
    await w.say("orch apply nope", MAINT);
    const reply = mock.mrNotes(w.path, w.mr.iid).at(-1);
    expect(reply?.body).toContain("Not applied");
    roleLookups = [];
    await handler(w.job(reply?.id ?? 0));
    expect(roleLookups).toEqual([]);
    expect(w.replies().length).toBe(1);
  });

  test("a note that is gone is dropped, and roles that cannot be read fail the job for a retry", async () => {
    const w = await plannedWorld();
    const ctx = w.note("orch apply", MAINT);
    mock.deleteMrNote(w.path, w.mr.iid, ctx.payload.noteId as number);
    await handler(ctx); // no throw
    expect(w.posts()).toBe(1);

    rolesFail = true;
    try {
      await expect(handler(w.note("orch apply", MAINT))).rejects.toMatchObject({
        code: "membership_unavailable",
      });
    } finally {
      rolesFail = false;
    }
    expect(await w.states()).toEqual({ app: "planned", net: "planned" });
    expect(w.replies()).toEqual([]);
  });

  test("no note text, name or secret of the commenter reaches a log line", async () => {
    const w = await plannedWorld();
    await w.say("orch apply nope", MAINT);
    await w.say("orch apply net\n/merge CANARY-NOTE-TEXT", MAINT);
    expect(lines.join("\n")).not.toContain("CANARY-NOTE-TEXT");
  });
});

describe("where the roles source is not set", () => {
  test("a GitLab note is ignored: nothing is planned or said", async () => {
    const w = await world();
    const bare = mrCommandHandler({ db: t.db, gitlab: async () => client(), config });
    await bare(w.note("orch plan", DEV));
    expect(await w.runs()).toBe(0);
    expect(w.replies()).toEqual([]);
  });
});
