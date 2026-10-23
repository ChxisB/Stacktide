import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { eq } from "drizzle-orm";
import {
  currentDeployments,
  deploymentOutcomes,
  hasSucceeded,
  listDeployments,
  type NewDeployment,
  previousSuccess,
  recordDeployment,
  recordSeenDeployment,
} from "./deployments";
import { createSink, NOTIFY_QUEUE, setSubscriptions } from "./notifications";
import { createOrganization, createProject, deleteProject } from "./repo";
import { jobs } from "./schema";
import { createTestDb, type TestDb } from "./testing";

// DEP-3: what GitLab last said about each deployment, kept the way a pipeline run is, and read per environment.

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.drop();
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
const sha = (c: string) => c.repeat(40);

let n = 0;
async function world() {
  const org = await createOrganization(t.db, { slug: `o${++n}`, name: "O" });
  const project = await createProject(t.db, { organizationId: org.id, name: `p${++n}` });
  const row = (over: Partial<NewDeployment> = {}): NewDeployment => ({
    organizationId: org.id,
    projectId: project.id,
    connectionId: null,
    gitlabDeploymentId: 100,
    environment: "staging",
    sha: sha("a"),
    ref: "main",
    status: "running",
    jobId: 7,
    pipelineId: 8,
    finishedAt: null,
    observedAt: at(10),
    ...over,
  });
  return { org, project, row };
}

describe("recording a deployment", () => {
  test("a later read replaces an earlier one", async () => {
    const w = await world();
    const first = await recordDeployment(t.db, w.row());
    const second = await recordDeployment(
      t.db,
      w.row({ status: "success", finishedAt: at(15), observedAt: at(20) }),
    );
    expect(first.stored).toBe(true);
    expect(second.stored).toBe(true);
    expect(second.deployment).toMatchObject({
      id: first.deployment.id,
      status: "success",
      finishedAt: at(15),
    });
  });

  test("an earlier read never replaces a later one, whatever it says", async () => {
    const w = await world();
    await recordDeployment(t.db, w.row({ status: "success", observedAt: at(20) }));
    const late = await recordDeployment(t.db, w.row({ status: "running", observedAt: at(10) }));
    expect(late.stored).toBe(false);
    expect(late.deployment).toMatchObject({ status: "success", observedAt: at(20) });
    expect((await listDeployments(t.db, w.org.id, w.project.id, { limit: 10 })).length).toBe(1);
  });

  test("one GitLab deployment is one row per project, and another project may use the same number", async () => {
    const w = await world();
    const other = await createProject(t.db, { organizationId: w.org.id, name: `p${++n}` });
    await recordDeployment(t.db, w.row());
    await recordDeployment(t.db, w.row({ sha: sha("b") }));
    await recordDeployment(t.db, w.row({ projectId: other.id }));
    expect((await listDeployments(t.db, w.org.id, w.project.id, { limit: 10 })).length).toBe(1);
    expect((await listDeployments(t.db, w.org.id, other.id, { limit: 10 })).length).toBe(1);
  });

  test("another organization cannot replace a project's deployment", async () => {
    const w = await world();
    const saved = await recordDeployment(t.db, w.row());
    const other = await createOrganization(t.db, { slug: `o${++n}`, name: "Other" });
    await expect(
      recordDeployment(
        t.db,
        w.row({ organizationId: other.id, status: "failed", observedAt: at(99) }),
      ),
    ).rejects.toThrow();
    const [again] = await listDeployments(t.db, w.org.id, w.project.id, { limit: 10 });
    expect(again).toEqual(saved.deployment);
  });

  test("a status that is not a lower-case word is refused", async () => {
    const w = await world();
    await expect(recordDeployment(t.db, w.row({ status: "Done!" }))).rejects.toThrow();
  });

  test("deleting the project removes its deployments", async () => {
    const w = await world();
    await recordDeployment(t.db, w.row());
    await deleteProject(t.db, w.org.id, w.project.id);
    expect(await listDeployments(t.db, w.org.id, w.project.id, { limit: 10 })).toEqual([]);
  });
});

describe("reading deployments", () => {
  async function seeded() {
    const w = await world();
    const rows: [number, string, string, string][] = [
      [101, "staging", "success", "a"],
      [102, "production", "success", "a"],
      [103, "staging", "success", "b"],
      [104, "production", "failed", "b"],
      [105, "staging", "running", "c"],
    ];
    for (const [id, environment, status, c] of rows) {
      await recordDeployment(
        t.db,
        w.row({ gitlabDeploymentId: id, environment, status, sha: sha(c) }),
      );
    }
    return w;
  }

  test("newest first by GitLab's id, with a cursor and filters", async () => {
    const w = await seeded();
    const ids = async (o: Parameters<typeof listDeployments>[3]) =>
      (await listDeployments(t.db, w.org.id, w.project.id, o)).map((d) => d.gitlabDeploymentId);
    expect(await ids({ limit: 2 })).toEqual([105, 104]);
    expect(await ids({ limit: 2, before: 104 })).toEqual([103, 102]);
    expect(await ids({ limit: 10, environment: "production" })).toEqual([104, 102]);
    expect(await ids({ limit: 10, status: "success" })).toEqual([103, 102, 101]);
  });

  test("current is the newest success and the last attempt is the newest of any status", async () => {
    const w = await seeded();
    const rows = await currentDeployments(t.db, w.org.id, w.project.id);
    expect(
      rows.map((r) => [
        r.environment,
        r.current?.gitlabDeploymentId,
        r.lastAttempt.gitlabDeploymentId,
      ]),
    ).toEqual([
      ["production", 102, 104],
      ["staging", 103, 105],
    ]);
  });

  test("an environment with only failures has no current", async () => {
    const w = await world();
    await recordDeployment(t.db, w.row({ gitlabDeploymentId: 1, status: "failed" }));
    await recordDeployment(t.db, w.row({ gitlabDeploymentId: 2, status: "canceled" }));
    const [only] = await currentDeployments(t.db, w.org.id, w.project.id);
    expect(only?.current).toBeNull();
    expect(only?.lastAttempt.gitlabDeploymentId).toBe(2);
  });

  test("a project with none has nothing, and another project's rows are not seen", async () => {
    const a = await seeded();
    const b = await world();
    expect(await currentDeployments(t.db, b.org.id, b.project.id)).toEqual([]);
    expect(await currentDeployments(t.db, b.org.id, a.project.id)).toEqual([]);
  });
});

describe("hasSucceeded", () => {
  test("only a success of that commit in this project, in any environment, counts", async () => {
    const a = await world();
    await recordDeployment(
      t.db,
      a.row({ gitlabDeploymentId: 1, status: "success", sha: sha("a") }),
    );
    await recordDeployment(
      t.db,
      a.row({ gitlabDeploymentId: 2, environment: "production", status: "failed", sha: sha("b") }),
    );
    await recordDeployment(
      t.db,
      a.row({ gitlabDeploymentId: 3, status: "running", sha: sha("c") }),
    );
    const asked = (w: typeof a, c: string) => hasSucceeded(t.db, w.org.id, w.project.id, sha(c));
    expect([
      await asked(a, "a"),
      await asked(a, "b"),
      await asked(a, "c"),
      await asked(a, "d"),
    ]).toEqual([true, false, false, false]);
    const b = await world();
    expect(await asked(b, "a")).toBe(false);
    // a project id under another organization's id finds nothing
    expect(await hasSucceeded(t.db, b.org.id, a.project.id, sha("a"))).toBe(false);
  });
});

describe("previousSuccess", () => {
  test("the newest success of the environment that is not this commit: failures and redeploys are skipped", async () => {
    const w = await world();
    let id = 0;
    for (const [environment, status, c] of [
      ["production", "success", "a"],
      ["production", "success", "b"],
      ["production", "failed", "x"],
      ["production", "success", "c"],
      ["production", "success", "c"], // a redeploy of the current build
      ["production", "running", "d"],
      ["staging", "success", "s"], // another environment's history is not this one's
    ] as const) {
      await recordDeployment(
        t.db,
        w.row({ gitlabDeploymentId: ++id, environment, status, sha: sha(c) }),
      );
    }
    const found = await previousSuccess(t.db, w.org.id, w.project.id, "production", sha("c"));
    expect(found?.sha).toBe(sha("b"));
    // asked again about that one, the answer is the one before it, which is a
    expect((await previousSuccess(t.db, w.org.id, w.project.id, "production", sha("b")))?.sha).toBe(
      sha("c"),
    );
    // only one commit ever succeeded there, or nothing did
    expect(
      await previousSuccess(t.db, w.org.id, w.project.id, "staging", sha("s")),
    ).toBeUndefined();
    expect(await previousSuccess(t.db, w.org.id, w.project.id, "qa", sha("c"))).toBeUndefined();
    const b = await world();
    expect(
      await previousSuccess(t.db, b.org.id, w.project.id, "production", sha("c")),
    ).toBeUndefined();
  });
});

describe("recording a deployment that GitLab has just reported", () => {
  const url = "https://gitlab.example/acme/web/-/pipelines/8";
  const listen = async (w: Awaited<ReturnType<typeof world>>) => {
    const s = await createSink(t.db, keys, {
      organizationId: w.org.id,
      kind: "webhook",
      name: `s${++n}`,
      host: "hooks.example",
      secret: "sealed-by-the-test",
    });
    await setSubscriptions(t.db, {
      organizationId: w.org.id,
      projectId: w.project.id,
      sinkId: s.id,
      events: ["deployment.failed"],
    });
    return s;
  };
  const told = async (w: Awaited<ReturnType<typeof world>>) =>
    (await t.db.select().from(jobs).where(eq(jobs.queue, NOTIFY_QUEUE))).filter(
      (j) => (j.payload as { projectId: string }).projectId === w.project.id,
    );
  const see = (w: Awaited<ReturnType<typeof world>>, over: Partial<NewDeployment> = {}) =>
    t.db.transaction((tx) => recordSeenDeployment(tx, w.row(over), url));

  test("a deployment that was running and is now failed tells its subscribers once", async () => {
    const w = await world();
    await listen(w);
    await see(w);
    expect(await told(w)).toEqual([]);

    const failed = { status: "failed", finishedAt: at(15), observedAt: at(20) };
    expect((await see(w, failed)).stored).toBe(true);
    const [job, ...more] = await told(w);
    expect(more).toEqual([]);
    expect(job?.payload).toMatchObject({
      event: "deployment.failed",
      environment: "staging",
      sha: "aaaaaaaa",
      pipelineUrl: url,
      at: at(15).toISOString(),
    });

    // the same report again, and a later one that still says failed: no second notification
    await see(w, failed);
    await see(w, { ...failed, observedAt: at(30) });
    expect(await told(w)).toHaveLength(1);
  });

  test("one reported failed from the start is told, and one already failed is not told again", async () => {
    const w = await world();
    await listen(w);
    await see(w, { gitlabDeploymentId: 1, status: "failed", observedAt: at(10) });
    expect(await told(w)).toHaveLength(1);
    await see(w, { gitlabDeploymentId: 1, status: "failed", observedAt: at(12) });
    expect(await told(w)).toHaveLength(1);
  });

  test("a read older than the one stored changes nothing and tells nobody", async () => {
    const w = await world();
    await listen(w);
    await see(w, { status: "success", finishedAt: at(15), observedAt: at(20) });
    const late = await see(w, { status: "failed", observedAt: at(10) });
    expect(late.stored).toBe(false);
    expect(await told(w)).toEqual([]);
  });

  test("two first reads of one failed deployment at the same time tell once: the one that lost is not the news", async () => {
    const w = await world();
    await listen(w);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const winner = t.db.transaction(async (tx) => {
      await recordSeenDeployment(tx, w.row({ status: "failed", observedAt: at(20) }), url);
      await held;
    });
    await Bun.sleep(50);
    // reads before the winner's row is visible, then waits on its insert
    const loser = see(w, { status: "failed", observedAt: at(10) });
    await Bun.sleep(50);
    release();
    await Promise.all([winner, loser]);
    expect(await told(w)).toHaveLength(1);
  });

  test("a failure after a failure that came back as running is told again: it is a new failure", async () => {
    const w = await world();
    await listen(w);
    await see(w, { status: "failed", observedAt: at(10) });
    await see(w, { status: "running", observedAt: at(20) });
    await see(w, { status: "failed", observedAt: at(30) });
    expect(await told(w)).toHaveLength(2);
  });

  test("a project with no subscription, and a deployment that did not fail, tell nobody", async () => {
    const w = await world();
    await see(w, { status: "failed", observedAt: at(10) });
    const x = await world();
    await listen(x);
    await see(x, { status: "success", finishedAt: at(15), observedAt: at(20) });
    expect(await told(w)).toEqual([]);
    expect(await told(x)).toEqual([]);
  });

  test("what is queued names the environment and the build, and nothing GitLab said about people or commits", async () => {
    const w = await world();
    await listen(w);
    await see(w, { status: "failed", observedAt: at(10) });
    const [job] = await told(w);
    expect(Object.keys(job?.payload as object).sort()).toEqual([
      "at",
      "environment",
      "event",
      "organizationId",
      "pipelineUrl",
      "projectId",
      "projectName",
      "sha",
      "sinkId",
    ]);
  });
});

describe("deploymentOutcomes", () => {
  test("only how deployments ended, read since a time, of one project, newest first, with the time each finished", async () => {
    const w = await world();
    const other = await world();
    await recordDeployment(
      t.db,
      w.row({ gitlabDeploymentId: 1, status: "success", finishedAt: at(5), observedAt: at(6) }),
    );
    await recordDeployment(
      t.db,
      w.row({ gitlabDeploymentId: 2, status: "failed", finishedAt: null, observedAt: at(20) }),
    );
    await recordDeployment(
      t.db,
      w.row({ gitlabDeploymentId: 3, status: "running", observedAt: at(30) }),
    );
    await recordDeployment(
      t.db,
      w.row({ gitlabDeploymentId: 4, status: "canceled", observedAt: at(30) }),
    );
    await recordDeployment(
      t.db,
      w.row({
        gitlabDeploymentId: 5,
        status: "success",
        environment: "production",
        finishedAt: at(40),
        observedAt: at(41),
      }),
    );
    await recordDeployment(
      t.db,
      w.row({ gitlabDeploymentId: 6, status: "success", finishedAt: at(2), observedAt: at(3) }),
    ); // read before `since`
    await recordDeployment(
      t.db,
      other.row({ gitlabDeploymentId: 7, status: "failed", observedAt: at(50) }),
    );

    const all = await deploymentOutcomes(t.db, w.org.id, w.project.id, { since: at(5), limit: 50 });
    expect(all).toEqual([
      { environment: "production", status: "success", at: at(40) },
      { environment: "staging", status: "failed", at: at(20) }, // never finished: the time it was read
      { environment: "staging", status: "success", at: at(5) },
    ]);
    const staging = await deploymentOutcomes(t.db, w.org.id, w.project.id, {
      since: at(5),
      environment: "staging",
      limit: 50,
    });
    expect(staging.map((r) => r.environment)).toEqual(["staging", "staging"]);
    expect(
      await deploymentOutcomes(t.db, w.org.id, w.project.id, { since: at(5), limit: 1 }),
    ).toHaveLength(1);
    expect(
      await deploymentOutcomes(t.db, other.org.id, w.project.id, { since: at(0), limit: 50 }),
    ).toEqual([]);
  });
});
