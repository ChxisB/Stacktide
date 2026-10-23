import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getPipelineConfig } from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import { type Backend, startBackend } from "../src/testing";
import { must } from "../src/variables.fixture";
import { type Demo, seedDemo, signInAs, until } from "./seed";

let backend: Backend;
let demo: Demo;
beforeAll(async () => {
  backend = await startBackend();
  demo = await seedDemo(backend);
});
afterAll(() => backend.stop());

const org = () => demo.owner.client.organizations({ orgId: demo.org.id });
const project = (id: string) => org().projects({ projectId: id });

describe("the demo world (DEMO-1)", () => {
  test("the owner is signed in and sees the projects that were imported, not the one that was not", async () => {
    const listed = must(await org().projects.get({ query: { limit: 100 } })).items;
    expect(listed.map((p) => p.name).sort()).toEqual(["acme/api", "acme/mobile", "acme/web"]);
  });

  test("one project is on GitHub, the others on GitLab (FRG-26), and the page is told which", async () => {
    const listed = must(await org().projects.get({ query: { limit: 100 } })).items;
    expect(Object.fromEntries(listed.map((p) => [p.name, p.forge]))).toEqual({
      "acme/api": "gitlab",
      "acme/mobile": "github",
      "acme/web": "gitlab",
    });
    const mobile = listed.find((p) => p.name === "acme/mobile");
    expect(mobile?.id).toBe(demo.mobile);
    // the mock GitHub is the one the connection points at: nothing leaves the machine
    expect(demo.hub.url).toStartWith("http://127.0.0.1");
  });

  test("the web project has the three environments of a real one", async () => {
    const listed = must(await project(demo.web).environments.get({ query: { limit: 100 } })).items;
    expect(listed.map((e) => e.slug).sort()).toEqual(["dev", "production", "staging"]);
  });

  test("variables are set at each level, secrets and plain values both", async () => {
    const atProject = must(await project(demo.web).variables.get({ query: { limit: 100 } })).items;
    expect(atProject.map((v) => [v.key, v.kind]).sort()).toEqual([
      ["API_URL", "plain"],
      ["LOG_LEVEL", "plain"],
    ]);
    const atOrg = must(await org().variables.get({ query: { limit: 100 } })).items;
    expect(atOrg.map((v) => [v.key, v.kind])).toEqual([["SENTRY_DSN", "secret"]]);
    for (const env of ["dev", "staging", "production"]) {
      const there = must(
        await project(demo.web)
          .environments({ envId: demo.envs[env] ?? "" })
          .variables.get({ query: { limit: 100 } }),
      ).items;
      expect(there.map((v) => v.key)).toContain("DATABASE_URL");
    }
  });

  test("variables carry tags, so the Variables page shows chips and a Tag filter", async () => {
    const dev = must(
      await project(demo.web)
        .environments({ envId: demo.envs.dev ?? "" })
        .variables.get({ query: { limit: 100 } }),
    ).items;
    expect(dev.find((v) => v.key === "DATABASE_URL")?.tags).toEqual(["database"]);
    const atProject = must(await project(demo.web).variables.get({ query: { limit: 100 } })).items;
    expect(atProject.find((v) => v.key === "LOG_LEVEL")?.tags).toEqual(["logging"]);
    expect(atProject.find((v) => v.key === "API_URL")?.tags).toEqual(["app", "public"]);
  });

  test("the web project has /payments and /search, each with a DATABASE_URL of its own in dev, so the Variables page shows folder rows (FLD-15)", async () => {
    const folders = must(await project(demo.web).folders.get()).items;
    expect(folders.map((f) => [f.path, f.variableCount]).sort()).toEqual([
      ["/payments", 1],
      ["/search", 1],
    ]);
    const dev = project(demo.web).environments({ envId: demo.envs.dev ?? "" });
    const urls = new Set<string | undefined>();
    for (const path of ["/payments", "/search"]) {
      const there = must(await dev.variables.get({ query: { limit: 100, folder: path } })).items;
      expect(there.map((v) => [v.key, v.kind])).toEqual([["DATABASE_URL", "secret"]]);
      urls.add(there[0]?.id);
    }
    // two variables, not one: the same key in two folders is two variables
    expect(urls.size).toBe(2);
  });

  test("there is a worker pool", async () => {
    const pools = must(await org().pools.get({ query: { limit: 100 } })).items;
    expect(pools.map((p) => p.name)).toEqual(["linux-runners"]);
  });

  test("no secret's value is in any list response", async () => {
    expect(demo.secrets.length).toBeGreaterThan(0);
    const seen = JSON.stringify([
      await org().variables.get({ query: { limit: 100 } }),
      // the connections hold the GitLab and GitHub tokens, and the projects point at them (FRG-26)
      await org().connections.get({ query: { limit: 100 } }),
      await org().projects.get({ query: { limit: 100 } }),
      await project(demo.mobile).get(),
      await project(demo.web).variables.get({ query: { limit: 100 } }),
      ...(await Promise.all(
        Object.values(demo.envs).map((envId) =>
          project(demo.web)
            .environments({ envId })
            .variables.get({ query: { limit: 100 } }),
        ),
      )),
      // the folders' too, which the root lists above do not hold
      ...(await Promise.all(
        ["/payments", "/search"].map((folder) =>
          project(demo.web)
            .environments({ envId: demo.envs.dev ?? "" })
            .variables.get({ query: { limit: 100, folder } }),
        ),
      )),
    ]);
    // the same search finds a plain value, so a pass means the secrets are not there, not that the search is blind
    expect(seen).toContain("https://api.acme.example");
    expect(seen).toContain("Acme GitHub");
    for (const value of demo.secrets) expect(seen).not.toContain(value);
  });

  test("the sign-in cookie is the owner's session", async () => {
    const res = await fetch(`${backend.api}/organizations/${demo.org.id}/projects?limit=1`, {
      headers: { cookie: demo.owner.cookie },
    });
    expect(res.status).toBe(200);
    expect(
      (await fetch(`${backend.api}/organizations/${demo.org.id}/projects?limit=1`)).status,
    ).toBe(401);
  });
  test("the sign-in link sets a new session of the owner at each click and goes to the app", async () => {
    const app = "http://127.0.0.1:3200/";
    const [a, b] = [await signInAs(backend, demo, app), await signInAs(backend, demo, app)];
    expect([a.status, a.headers.get("location")]).toEqual([302, app]);
    const cookie = (r: Response) => r.headers.get("set-cookie") ?? "";
    expect(cookie(a)).toContain("HttpOnly");
    expect(cookie(a).split(";")[0]).not.toBe(cookie(b).split(";")[0]);
    for (const r of [a, b]) {
      const res = await fetch(`${backend.api}/organizations/${demo.org.id}/projects?limit=1`, {
        headers: { cookie: cookie(r).split(";")[0] ?? "" },
      });
      expect(res.status).toBe(200);
    }
  });
});

describe("something on every page (DEMO-2)", () => {
  const web = () => project(demo.web);
  /** The target's id; not the client for it, which an async function must not return (awaiting it calls `then` on it). */
  const targetId = async () => {
    const targets = must(await web()["sync-targets"].get({ query: { limit: 100 } })).items;
    expect(targets.map((t) => [t.name, t.type])).toEqual([["acme-web-ci", "gitlab-variables"]]);
    return targets[0]?.id ?? "";
  };
  const onTarget = (id: string) => web()["sync-targets"]({ targetId: id });

  test("Status: the newest pipeline of eight branches, in every state, the failures saying why", async () => {
    const runs = must(await web()["pipeline-runs"].latest.get({ query: { limit: 50 } })).runs;
    expect(new Set(runs.map((r) => r.ref)).size).toBe(8);
    expect(new Set(runs.map((r) => r.status))).toEqual(
      new Set(["success", "failed", "running", "pending", "canceled"]),
    );
    expect(
      runs
        .filter((r) => r.status === "failed")
        .map((r) => [r.failureReason, r.failedJob])
        .sort(),
    ).toEqual([
      ["job_execution_timeout", "e2e"],
      ["script_failure", "test"],
    ]);
    // main failed once before it passed: the newest one is what the page shows
    expect(runs.find((r) => r.ref === "main")?.status).toBe("success");
  });

  test("Status: a pipeline's jobs show a pass, a failure with its reason, and a job still running, with the time each took", async () => {
    const runs = must(await web()["pipeline-runs"].latest.get({ query: { limit: 50 } })).runs;
    const jobsOf = async (ref: string) =>
      must(
        await web()
          ["pipeline-runs"]({ runId: runs.find((r) => r.ref === ref)?.id ?? "" })
          .jobs.get(),
      ).jobs;
    const shape = (jobs: Awaited<ReturnType<typeof jobsOf>>) =>
      jobs.map((j) => [j.name, j.status, j.failureReason]);

    const passed = await jobsOf("main");
    expect(shape(passed)).toEqual([
      ["build", "success", null],
      ["lint", "success", null],
      ["test", "success", null],
      ["e2e", "success", null],
      ["deploy", "success", null],
    ]);
    // a job that ran took a time; the start is before the end and the seconds are what lies between
    for (const j of passed) {
      expect(j.duration).toBeGreaterThan(0);
      expect(Date.parse(j.finishedAt ?? "") - Date.parse(j.startedAt ?? "")).toBe(
        (j.duration ?? 0) * 1000,
      );
    }

    // a failure stops the stages after it: those jobs were never run, so they took no time
    const failed = await jobsOf("feature/billing");
    expect(shape(failed)).toEqual([
      ["build", "success", null],
      ["lint", "success", null],
      ["test", "failed", "script_failure"],
      ["e2e", "skipped", null],
      ["deploy", "skipped", null],
    ]);
    expect(failed.map((j) => j.duration !== null)).toEqual([true, true, true, false, false]);
    expect((await jobsOf("feature/audit-export")).find((j) => j.status === "failed")).toMatchObject(
      { name: "e2e", failureReason: "job_execution_timeout" },
    );

    const going = await jobsOf("feature/search");
    expect(shape(going)).toEqual([
      ["build", "success", null],
      ["lint", "success", null],
      ["test", "running", null],
      ["e2e", "pending", null],
      ["deploy", "pending", null],
    ]);
    expect(going.find((j) => j.status === "running")?.duration).toBeNull();
  });

  test("Status: main's newest pipeline has a trigger into a child pipeline of two jobs, and the child has no row of its own", async () => {
    const runs = must(await web()["pipeline-runs"].latest.get({ query: { limit: 50 } })).runs;
    const jobsOf = async (runId: string) =>
      must(await web()["pipeline-runs"]({ runId }).jobs.get());
    const main = runs.find((r) => r.ref === "main");
    const seen = await jobsOf(main?.id ?? "");
    expect(
      seen.triggers.map((t) => [
        t.name,
        t.stage,
        t.status,
        t.downstream?.sameProject,
        t.downstream?.gone,
      ]),
    ).toEqual([
      ["release", "deploy", "success", true, false],
      // NOD-12: the same pipeline also hands over to acme/api (the next test)
      ["deploy-api", "deploy", "success", false, false],
    ]);
    expect(seen.children).toHaveLength(1);
    const [child] = seen.children;
    expect(child?.jobs.map((j) => [j.name, j.status])).toEqual([
      ["migrate", "success"],
      ["smoke", "success"],
    ]);
    for (const j of child?.jobs ?? []) expect(j.duration).toBeGreaterThan(0);
    // the seed records the pipelines of PIPELINES only: the child is drawn under its parent, not a row of Status
    expect(runs.map((r) => r.gitlabPipelineId)).not.toContain(child?.pipelineId);
    // no other pipeline starts one
    for (const r of runs.filter((x) => x.id !== main?.id)) {
      expect((await jobsOf(r.id)).triggers).toEqual([]);
    }
  });

  test("Status: main's newest pipeline hands over to acme/api, which is imported and holds a run of that pipeline with two passed jobs", async () => {
    const runs = must(await web()["pipeline-runs"].latest.get({ query: { limit: 50 } })).runs;
    const main = runs.find((r) => r.ref === "main");
    const seen = must(
      await web()
        ["pipeline-runs"]({ runId: main?.id ?? "" })
        .jobs.get(),
    );
    const handover = seen.triggers.find((t) => t.name === "deploy-api");
    const downstream = handover?.downstream;
    if (!downstream) throw new Error("the deploy-api trigger started no pipeline");
    // GitLab's number of acme/api, which is how the page finds it among the projects its viewer can see
    const listed = must(await org().projects.get({ query: { limit: 100 } })).items;
    const api = listed.find((p) => p.name === "acme/api");
    expect(api?.id).toBe(demo.api);
    expect(downstream.projectId).toBe(api?.gitlabProjectId ?? null);
    expect(downstream.status).toBe("success");
    // acme/web's own Status does not list it: it is acme/api's run
    expect(runs.map((r) => r.gitlabPipelineId)).not.toContain(downstream.pipelineId);
    const theirs = project(demo.api)["pipeline-runs"];
    const found = must(
      await theirs.get({ query: { pipelineId: downstream.pipelineId, limit: 1 } }),
    );
    expect(found.runs.map((r) => [r.ref, r.status])).toEqual([["main", "success"]]);
    const jobs = must(await theirs({ runId: found.runs[0]?.id ?? "" }).jobs.get());
    expect(jobs.jobs.map((j) => [j.name, j.status])).toEqual([
      ["canary", "success"],
      ["rollout", "success"],
    ]);
    for (const j of jobs.jobs) expect(j.duration).toBeGreaterThan(0);
    // the address of the recorded run is on the same GitLab as the viewing run's: the page only trusts that
    expect(new URL(found.runs[0]?.webUrl ?? "").origin).toBe(new URL(main?.webUrl ?? "").origin);
  });

  test("State: two stacks, each with versions", async () => {
    const serials = async (stack: string) =>
      must(await web().state({ stack }).versions.get()).map((v) => v.serial);
    expect(await serials("network")).toEqual([3, 2, 1]);
    expect(await serials("app")).toEqual([2, 1]);
  });

  test("Findings: one of each severity", async () => {
    const found = must(await web().findings.get({ query: { limit: 100 } })).items;
    expect(found.map((f) => f.severity).sort()).toEqual(["critical", "high", "low", "medium"]);
  });

  test("Sync: a target that was applied once and has drifted by one change since", async () => {
    const at = onTarget(await targetId());
    expect(must(await at["last-run"].get()).run?.status).toBe("applied");
    const drift = must(await at.drift.get());
    expect([drift.status, drift.counts.update, drift.counts.create]).toEqual(["drifted", 1, 0]);
  });

  test("none of it carries a secret's value", async () => {
    const at = onTarget(await targetId());
    const seen = JSON.stringify([
      await web()["pipeline-runs"].latest.get({ query: { limit: 50 } }),
      await web().state({ stack: "network" }).versions.get(),
      await web().findings.get({ query: { limit: 100 } }),
      await at["last-run"].get(),
      await at.drift.get(),
    ]);
    for (const value of demo.secrets) expect(seen).not.toContain(value);
  });

  // last: this changes the world (an apply, a retry)
  test("live: the plan of the drifted target applies, GitLab then holds the change and the target is in sync; a failed run retries", async () => {
    const at = onTarget(await targetId());
    const before = must(await at["last-run"].get()).run?.id;
    must(await at.apply.post({ planId: must(await at.plan.post()).id }));
    await until("the apply", async () => {
      const last = must(await at["last-run"].get()).run;
      return last?.id !== before && last?.status === "applied";
    });
    const gitlab = createGitlab({
      baseUrl: demo.mock.url,
      auth: { type: "private-token", token: demo.mock.token },
      maxRetries: 0,
    });
    const held: Record<string, string> = {};
    for await (const v of gitlab.variables.list({ project: "acme/web" }))
      held[`${v.key} ${v.scope}`] = v.value ?? "";
    expect(held["LOG_LEVEL *"]).toBe("debug");

    await demo.checkDrift();
    await until("the drift check", async () => must(await at.drift.get()).status === "in_sync");

    const failed = must(
      await web()["pipeline-runs"].latest.get({ query: { limit: 50 } }),
    ).runs.find((r) => r.status === "failed");
    must(
      await web()
        ["pipeline-runs"]({ runId: failed?.id ?? "" })
        .retry.post(),
    );
    expect(
      demo.mock.requests.filter((r) => r.method === "POST" && /\/retry$/.test(r.path)),
    ).toHaveLength(1);
  });
});

// DEP-22: the Deployments card on the Status page has something to show, and the numbers under each box have something to say.
describe("deployments on the Status page (DEP-22)", () => {
  const on = () => project(demo.web).deployments;
  const boxes = async () =>
    Object.fromEntries(must(await on().environments.get()).environments.map((e) => [e.slug, e]));

  test("acme/web is set up with docker-deploy, and its environments are in the order a build goes through them", async () => {
    expect((await getPipelineConfig(backend.t.db, demo.org.id, demo.web))?.template).toBe(
      "docker-deploy",
    );
    const listed = must(await on().environments.get()).environments.map((e) => e.slug);
    expect(listed).toEqual(["dev", "staging", "production"]);
  });

  test("dev and staging have a build, and production an older success with a newer failure beside it", async () => {
    const at = await boxes();
    expect(at.dev?.current?.status).toBe("success");
    expect(at.staging?.current?.status).toBe("success");
    expect(at.production?.current?.status).toBe("success");
    expect(at.production?.lastAttempt?.status).toBe("failed");
    expect(at.production?.lastAttempt?.sha).not.toBe(at.production?.current?.sha);
    // the build in dev is the newest, so a promotion to staging has something to offer
    expect(at.dev?.current?.sha).not.toBe(at.staging?.current?.sha);
    // Roll back is offered where an earlier build is there to go back to
    expect(
      [at.dev?.rollbackTo, at.staging?.rollbackTo, at.production?.rollbackTo].map(Boolean),
    ).toEqual([true, true, true]);
  });

  test("the numbers: a failure fixed in ten minutes in staging, one not yet fixed in production", async () => {
    const numbers = must(await on().stats.get({ query: { days: 30 } })).environments;
    const by = Object.fromEntries(numbers.map((n) => [n.environment, n]));
    expect(by.staging).toMatchObject({ deployments: 3, failed: 1, medianRestoreSeconds: 600 });
    expect(by.production).toMatchObject({ deployments: 2, failed: 1, medianRestoreSeconds: null });
    expect(by.dev).toMatchObject({ deployments: 2, failed: 0, medianRestoreSeconds: null });
  });

  test("what GitLab says of the people and the commit is not in what the card is given", async () => {
    const seen = JSON.stringify([
      await on().environments.get(),
      await on().get({ query: { limit: 100 } }),
      await on().stats.get({ query: { days: 30 } }),
    ]);
    for (const word of ["Mock Deployer", "mock-deployer", "mock commit title", "mock@example.test"])
      expect(seen).not.toContain(word);
  });
});
