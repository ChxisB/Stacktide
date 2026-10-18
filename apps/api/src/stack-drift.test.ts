import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  jobs,
  listRuns,
  listStackDrift,
  MAX_RUN_STACKS,
  markDriftRequested,
  planPipelinesOfRun,
  STACK_DRIFT_CHECK_QUEUE,
  STACK_DRIFT_TICK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab, GitlabError } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { and, eq } from "drizzle-orm";
import { stackDriftCheckHandler, stackDriftTickHandler } from "./stack-drift";
import type { JobContext, JobHandler } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let elsewhere: ReturnType<typeof createMockGitlab>;
let org: string;
let reaching: string;
let blind: string;
let other: string;
const tried: string[] = [];
const logger = createLogger({ level: "error", write: () => {} });

const client = (url: string, token: string) =>
  createGitlab({ baseUrl: url, auth: { type: "private-token", token }, maxRetries: 0 });
const config = {
  apiUrl: "https://orch.example.com",
  audience: "orch.example.com",
  helperImage: "ghcr.io/example/orch-helper:1",
};

const T0 = Date.UTC(2026, 9, 18, 12, 0);
/** The fake clock `m` minutes after the first check. */
const at = (m: number) => new Date(T0 + m * 60_000);
let clock = at(0);
const setNow = (m: number) => {
  clock = at(m);
};
const check = (): JobHandler =>
  stackDriftCheckHandler({
    db: t.db,
    config,
    now: () => clock,
    // `blind` is a connection to a GitLab that does not have the projects
    gitlab: async (_org, connectionId) => {
      tried.push(connectionId);
      return connectionId === blind
        ? client(elsewhere.url, elsewhere.token)
        : client(mock.url, mock.token);
    },
  });

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  elsewhere = createMockGitlab({ scopes: ["api"] });
  org = (await createOrganization(t.db, { slug: "one", name: "One" })).id;
  // listed by id, first: not a GitLab connection, which is never tried
  other = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "vault",
      name: "a-vault",
      config: {},
      token: "not-a-gitlab-token",
    })
  ).id;
  // then the one that cannot reach the projects
  blind = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "gitlab",
      name: "a-elsewhere",
      config: { baseUrl: elsewhere.url },
      token: elsewhere.token,
    })
  ).id;
  reaching = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "gitlab",
      name: "b-live",
      config: { baseUrl: mock.url },
      token: mock.token,
    })
  ).id;
});
afterAll(async () => {
  mock.stop();
  elsewhere.stop();
  await t.drop();
});

const job = (payload: Record<string, unknown>, queue = STACK_DRIFT_CHECK_QUEUE): JobContext => ({
  id: "job",
  queue,
  payload,
  attempt: 1,
  maxAttempts: 5,
  log: logger,
  signal: new AbortController().signal,
});

const BACKEND = 'terraform {\n  backend "http" {}\n}\n';
const stack = (name: string, extra = "") =>
  `name: ${name}\ntool: terraform\nversion: 1.9.0\n${extra}`;
const FILES: Record<string, string> = {
  ".gitlab-ci.yml": "noop:\n  script: [echo]\n",
  "stacks/net/stack.yml": stack("net", "drift_every: 6h\n"),
  "stacks/net/main.tf": BACKEND,
  "stacks/app/stack.yml": stack("app", "depends_on: [net]\ndrift_every: 1d\n"),
  "stacks/app/main.tf": BACKEND,
  "stacks/tmp/stack.yml": stack("tmp"),
  "stacks/tmp/main.tf": BACKEND,
};
const TERRAFORM = [{ tag: "terraform" as const, confidence: "high" as const, evidence: ["a.tf"] }];

let n = 0;
async function world(
  opts: {
    files?: Record<string, string>;
    detectedTypes?: NonNullable<Parameters<typeof createProject>[1]["detectedTypes"]>;
    linked?: boolean;
  } = {},
) {
  const id = ++n;
  const gl = mock.addProject({ path: `sd/p${id}`, files: opts.files ?? FILES });
  const project = await createProject(t.db, {
    organizationId: org,
    name: `p${id}`,
    detectedTypes: opts.detectedTypes ?? TERRAFORM,
    ...(opts.linked === false ? {} : { gitlabProjectId: gl.id }),
  });
  const api = client(mock.url, mock.token);
  const w = {
    gl,
    api,
    project,
    run: (h: JobHandler = check()) => h(job({ organizationId: org, projectId: project.id })),
    runs: () => listRuns(t.db, org, project.id, { limit: 50 }),
    known: () => listStackDrift(t.db, org, project.id),
    posts: () =>
      mock.requests.filter(
        (r) => r.method === "POST" && r.path.endsWith(`/projects/${gl.id}/pipeline`),
      ).length,
    head: async () => (await api.repository.getBranch(gl.id, "main")).commitId,
  };
  return w;
}
type World = Awaited<ReturnType<typeof world>>;

const drifts = (w: World) =>
  t.db
    .select()
    .from(auditEvents)
    .where(and(eq(auditEvents.projectId, w.project.id), eq(auditEvents.action, "run.create")));

describe("the schedule's tick", () => {
  test("asks for a check of each project with stacks", async () => {
    const w = await world();
    const ignored = await world({ detectedTypes: [] });
    await stackDriftTickHandler({ db: t.db })(job({}, STACK_DRIFT_TICK_QUEUE));
    const queued = (await t.db.select().from(jobs).where(eq(jobs.queue, STACK_DRIFT_CHECK_QUEUE)))
      .map((j) => (j.payload as { projectId: string }).projectId)
      .sort();
    expect(queued).toContain(w.project.id);
    expect(queued).not.toContain(ignored.project.id);
  });
});

describe("checking a project", () => {
  test("plans the stacks that have a cadence, on the default branch, and nothing else", async () => {
    setNow(0);
    const w = await world();
    const head = await w.head();
    await w.run();

    const [run, ...more] = await w.runs();
    expect(more).toEqual([]);
    expect(run).toMatchObject({ kind: "drift", ref: "main", sha: head, mergeRequestIid: null });
    // `tmp` has no `drift_every`
    expect(run?.stacks.map((s) => [s.stack, s.status])).toEqual([
      ["app", "queued"],
      ["net", "queued"],
    ]);

    const pipelines = await planPipelinesOfRun(t.db, org, w.project.id, run?.id as string);
    expect(pipelines).toHaveLength(1);
    const pipeline = await w.api.pipelines.get(w.gl.id, pipelines[0] as number);
    expect(pipeline.ref).toBe("main");
    const vars = mock.pipelineVariables(pipelines[0] as number) ?? [];
    expect(vars).toHaveLength(1);
    expect(vars[0]).toMatchObject({ key: "ORCH_CHILD_PIPELINE", type: "file" });
    const yaml = vars[0]?.value ?? "";
    for (const name of ["plan:net", "plan:app", "summary:net", "summary:app"]) {
      expect(yaml).toContain(name);
    }
    // a plan only: no job that applies, and not the stack without a cadence
    expect(yaml).not.toContain("apply:net");
    expect(yaml).not.toContain("plan:tmp");
    expect(yaml).toContain(`/runs/${run?.id}/plan-summary"`);

    // what the cadence counts from
    expect((await w.known()).map((k) => [k.stack, k.status, k.requestedAt])).toEqual([
      ["app", "unknown", clock],
      ["net", "unknown", clock],
    ]);
    const [event] = await drifts(w);
    expect(event).toMatchObject({
      actorKind: "job",
      actorId: "job",
      resourceId: run?.id,
      metadata: { ref: "main", sha: head, kind: "drift" },
    });
  });

  test("a stack is asked for again after its period, less five minutes, and not before", async () => {
    setNow(0);
    const w = await world();
    await w.run();
    expect(await w.runs()).toHaveLength(1);

    // 6h for `net`, 1d for `app`
    setNow(6 * 60 - 6);
    await w.run();
    expect(await w.runs()).toHaveLength(1);
    expect(w.posts()).toBe(1);

    setNow(6 * 60 - 5);
    await w.run();
    const runs = await w.runs();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.stacks.map((s) => s.stack)).toEqual(["net"]);
    expect((await w.known()).map((k) => [k.stack, k.requestedAt])).toEqual([
      ["app", at(0)],
      ["net", at(6 * 60 - 5)],
    ]);

    // `app` is due a day after its first check (less the five minutes), and `net` is due again too
    setNow(24 * 60 - 5);
    await w.run();
    expect((await w.runs())[0]?.stacks.map((s) => s.stack)).toEqual(["app", "net"]);
    // nothing reported: the cadence counts from when a check was asked for
    expect((await w.known()).every((k) => k.status === "unknown")).toBe(true);
  });

  test("a stack that is new to the schedule is asked for at once, the others wait", async () => {
    setNow(0);
    const w = await world({
      files: { ...FILES, "stacks/tmp/stack.yml": stack("tmp", "drift_every: 1h\n") },
    });
    // `app` and `net` were asked for a moment ago; `tmp` has not been
    for (const name of ["app", "net"]) {
      await markDriftRequested(
        t.db,
        { organizationId: org, projectId: w.project.id, stack: name },
        at(0),
      );
    }
    setNow(10);
    await w.run();
    const runs = await w.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.stacks.map((s) => s.stack)).toEqual(["tmp"]);
    expect(runs[0]?.sha).toBe(await w.head());
  });

  test("two checks of a project at once make one run", async () => {
    setNow(0);
    const w = await world();
    await Promise.all([w.run(), w.run()]);
    expect(await w.runs()).toHaveLength(1);
    expect(w.posts()).toBe(1);
  });

  test("no stack with a cadence, no run and no pipeline", async () => {
    const w = await world({
      files: {
        ...FILES,
        "stacks/net/stack.yml": stack("net"),
        "stacks/app/stack.yml": stack("app"),
      },
    });
    await w.run();
    expect(await w.runs()).toEqual([]);
    expect(await w.known()).toEqual([]);
    expect(w.posts()).toBe(0);
  });

  test("a stack file with errors is left out and the others are checked", async () => {
    setNow(0);
    const w = await world({
      files: { ...FILES, "stacks/tmp/stack.yml": "name: tmp\ntool: terraform\nbogus: [\n" },
    });
    await w.run();
    expect((await w.runs())[0]?.stacks.map((s) => s.stack)).toEqual(["app", "net"]);
  });

  test("dependencies that cannot be resolved plan nothing", async () => {
    const w = await world({
      files: { ...FILES, "stacks/net/stack.yml": "name: net\ntool: terraform\nbogus: [\n" },
    });
    await w.run();
    // `app` depends on the stack that is gone from the scan
    expect(await w.runs()).toEqual([]);
    expect(w.posts()).toBe(0);
  });

  test("a stack whose pipeline cannot be generated is not planned, and nothing is recorded", async () => {
    const w = await world({
      files: { ...FILES, "stacks/net/stack.yml": "name: net\ntool: terraform\ndrift_every: 6h\n" },
    });
    await w.run();
    expect(await w.runs()).toEqual([]);
    expect(await w.known()).toEqual([]);
    expect(w.posts()).toBe(0);
  });

  // MAX_RUN_STACKS stacks s000.., and one that is first by path but last by name
  const manyFiles = () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_RUN_STACKS }, (_, i) => {
        const name = `s${String(i).padStart(3, "0")}`;
        return [`many/${name}/stack.yml`, stack(name, "drift_every: 1h\n")];
      }),
    );
    files["many/00-last/stack.yml"] = stack("zz-last", "drift_every: 1h\n");
    return { ".gitlab-ci.yml": FILES[".gitlab-ci.yml"] ?? "", ...files };
  };

  test("at most a run's worth are planned at once, the rest wait for the next tick", async () => {
    setNow(0);
    const w = await world({ files: manyFiles() });
    await w.run();
    let runs = await w.runs();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.stacks).toHaveLength(MAX_RUN_STACKS);
    expect((await w.known()).length).toBe(MAX_RUN_STACKS);

    await w.run();
    runs = await w.runs();
    expect(runs).toHaveLength(2);
    // by name when none has waited longer than another: the repository's order is not the rule
    expect(runs[0]?.stacks.map((s) => s.stack)).toEqual(["zz-last"]);
  });

  test("when more are due than a run holds, the stacks that have waited longest go first", async () => {
    setNow(0);
    const w = await world({ files: manyFiles() });
    await w.run();
    // an hour on, all of them are due: the one never asked for goes before ones asked for an hour ago
    setNow(60);
    await w.run();
    const [latest] = await w.runs();
    expect(latest?.stacks).toHaveLength(MAX_RUN_STACKS);
    const names = latest?.stacks.map((s) => s.stack) ?? [];
    expect(names).toContain("zz-last");
    expect(names).not.toContain("s099");
  });
});

describe("what goes wrong", () => {
  test("a pipeline GitLab refuses leaves no run, is not asked again before the period, and does not fail the job", async () => {
    setNow(0);
    const files = { ...FILES };
    delete files[".gitlab-ci.yml"];
    const w = await world({ files });
    await w.run();
    expect(await w.runs()).toEqual([]);
    expect((await w.known()).map((k) => k.stack)).toEqual(["app", "net"]);
    const before = w.posts();

    setNow(60);
    await w.run();
    expect(w.posts()).toBe(before);
  });

  test("a connection that cannot reach the project is passed over for one that can", async () => {
    const w = await world();
    await w.run();
    expect(await w.runs()).toHaveLength(1);
    // the connection tried first (by id) looked, found nothing, and was passed over
    expect(elsewhere.requests.some((r) => r.path.includes(`/projects/${w.gl.id}/`))).toBe(true);
    expect(elsewhere.requests.every((r) => !r.path.endsWith("/pipeline"))).toBe(true);
    expect(other < blind && blind < reaching).toBe(true);
    expect(tried).toContain(blind);
    expect(tried).not.toContain(other);
  });

  test("no connection reaches the project: nothing is made, and the job does not fail", async () => {
    const lonely = await createOrganization(t.db, { slug: "lonely", name: "Lonely" });
    await createConnection(t.db, keys, {
      organizationId: lonely.id,
      type: "gitlab",
      name: "blind",
      config: { baseUrl: elsewhere.url },
      token: elsewhere.token,
    });
    const gl = mock.addProject({ path: "sd/lonely", files: FILES });
    const project = await createProject(t.db, {
      organizationId: lonely.id,
      name: "p",
      gitlabProjectId: gl.id,
      detectedTypes: TERRAFORM,
    });
    const handler = stackDriftCheckHandler({
      db: t.db,
      config,
      now: () => clock,
      gitlab: async () => client(elsewhere.url, elsewhere.token),
    });
    await handler(job({ organizationId: lonely.id, projectId: project.id }));
    expect(await listRuns(t.db, lonely.id, project.id, { limit: 5 })).toEqual([]);
    expect(await listStackDrift(t.db, lonely.id, project.id)).toEqual([]);
  });

  test("an organization with no connection has nothing to check with", async () => {
    const bare = await createOrganization(t.db, { slug: "bare", name: "Bare" });
    const gl = mock.addProject({ path: "sd/bare", files: FILES });
    const project = await createProject(t.db, {
      organizationId: bare.id,
      name: "p",
      gitlabProjectId: gl.id,
      detectedTypes: TERRAFORM,
    });
    const before = mock.requests.length;
    await check()(job({ organizationId: bare.id, projectId: project.id }));
    expect(mock.requests.length).toBe(before);
  });

  test("a project that is gone, unlinked, or not Terraform is left alone without asking GitLab", async () => {
    const unlinked = await world({ linked: false });
    const plain = await world({ detectedTypes: [] });
    const before = mock.requests.length;
    await unlinked.run();
    await plain.run();
    await check()(job({ organizationId: org, projectId: "01a14e37-2c5f-74c1-af88-1fb31f1a7750" }));
    expect(mock.requests.length).toBe(before);
    expect(await unlinked.runs()).toEqual([]);
    expect(await plain.runs()).toEqual([]);
  });

  test("a GitLab that fails for another reason fails the job so that it is retried, and records nothing", async () => {
    const w = await world();
    const broken = stackDriftCheckHandler({
      db: t.db,
      config,
      now: () => clock,
      gitlab: async () => {
        throw new Error("boom");
      },
    });
    await expect(w.run(broken)).rejects.toThrow("boom");
    expect(await w.known()).toEqual([]);
  });

  test("a pipeline that fails to start for another reason fails the job, and the next try makes the run", async () => {
    setNow(0);
    const w = await world();
    const down = stackDriftCheckHandler({
      db: t.db,
      config,
      now: () => clock,
      gitlab: async () => {
        const real = client(mock.url, mock.token);
        return {
          ...real,
          pipelines: {
            ...real.pipelines,
            trigger: async () => {
              throw new GitlabError("server", "GitLab is down", 503);
            },
          },
        };
      },
    });
    await expect(w.run(down)).rejects.toThrow("GitLab is down");
    // all of it rolled back: no run, and the stacks are not marked as asked for, so the retry asks
    expect(await w.runs()).toEqual([]);
    expect(await w.known()).toEqual([]);
    await w.run();
    expect(await w.runs()).toHaveLength(1);
  });

  test("a payload that is not ids is refused", async () => {
    await expect(check()(job({ organizationId: "x" }))).rejects.toThrow();
  });
});
