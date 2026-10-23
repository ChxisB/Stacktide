import { driftCheckHandler } from "@orch/api/sync-drift";
import { hashToken, randomToken } from "@orch/api/tokens";
import { createLogger, parseStateResources } from "@orch/core";
import {
  createSession,
  DRIFT_CHECK_QUEUE,
  putState,
  queueDriftChecks,
  recordPipelineRun,
  savePipelineConfig,
  upsertFindings,
} from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import type { Backend } from "../src/testing";
import { must } from "../src/variables.fixture";

// Everything here is invented, and says so: no name, value or key is read from the machine, and a value
// that looks like a secret is `demo-...` so nobody takes it for one.
const ENVIRONMENTS = ["dev", "staging", "production"] as const;
/** Long enough for a day of showing it, short enough that a forgotten demo signs itself out. */
const SESSION_MS = 12 * 3_600_000;
/** Values the seed stores as secrets: the demo's tests look for each in every list response. */
const secretOf = (name: string) => `demo-not-a-real-secret-${name}`;

/** Polls for what the worker is doing in the background (an apply, a drift check). */
export async function until(what: string, done: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await done()) return;
    await Bun.sleep(25);
  }
  throw new Error(`the demo waited 10 s for ${what}`);
}

// the newest pipeline of each branch is what the Status page shows; oldest first, so `main` passes after it failed
const PIPELINES = [
  { ref: "main", status: "failed", minutesAgo: 4320, why: ["script_failure", "test"] },
  { ref: "release/1.2", status: "success", minutesAgo: 2880 },
  { ref: "chore/deps", status: "canceled", minutesAgo: 1500 },
  { ref: "feature/onboarding", status: "success", minutesAgo: 600 },
  {
    ref: "feature/audit-export",
    status: "failed",
    minutesAgo: 240,
    why: ["job_execution_timeout", "e2e"],
  },
  { ref: "feature/billing", status: "failed", minutesAgo: 95, why: ["script_failure", "test"] },
  { ref: "main", status: "success", minutesAgo: 40 },
  { ref: "hotfix/login", status: "pending", minutesAgo: 2 },
  { ref: "feature/search", status: "running", minutesAgo: 1 },
] as const;

// the jobs of acme/web's CI file in the order a runner takes them: name, the number of its stage, seconds it takes
const JOBS = [
  ["build", 0, 48],
  ["lint", 1, 21],
  ["test", 1, 94],
  ["e2e", 2, 312],
  ["deploy", 3, 37],
] as const;

// the child pipeline the newest `main` pipeline starts (its `release` trigger, in the deploy stage): name, seconds it takes
const CHILD_JOBS = [
  ["migrate", 41],
  ["smoke", 18],
] as const;

// the pipeline of acme/api the same pipeline's `deploy-api` trigger starts (a multi-project pipeline): name, seconds it takes
const HANDOVER_JOBS = [
  ["canary", 23],
  ["rollout", 52],
] as const;

/** What each job of `JOBS` is in once `p` has been played; undefined leaves it as GitLab made it, pending. */
const jobStates = (p: (typeof PIPELINES)[number]) =>
  JOBS.map(([name, stage], i) => {
    if (p.status === "success") return "success";
    // part way: the first two have passed, the third is running
    if (p.status === "running") return i < 2 ? "success" : i === 2 ? "running" : undefined;
    // the cancel takes the rest
    if (p.status === "canceled") return i === 0 ? "success" : undefined;
    if (p.status !== "failed") return undefined;
    // a failure stops the stages after its own: those jobs never run
    const failedStage = JOBS.find(([n]) => n === p.why[1])?.[1] ?? 0;
    return name === p.why[1] ? "failed" : stage <= failedStage ? "success" : "skipped";
  });

// what GitLab has recorded of acme/web's deployments: environment, build, how it ended, minutes ago. The newest build is
// in dev only; staging's failure was fixed ten minutes after it; production's newest build failed, so its card has the
// build that is there, the attempt that failed, and a build to roll back to.
const DEPLOYMENTS = [
  ["staging", "5ad1c0de", "success", 4320],
  ["production", "5ad1c0de", "success", 4200],
  ["staging", "9f2b7e41", "failed", 3000],
  ["staging", "c4d8a6f0", "success", 2990],
  ["production", "c4d8a6f0", "success", 1800],
  ["dev", "7be2f3c1", "success", 660],
  ["staging", "7be2f3c1", "success", 600],
  ["production", "7be2f3c1", "failed", 120],
  ["dev", "e3f4a5b6", "success", 30],
] as const;

const AWS = 'provider["registry.terraform.io/hashicorp/aws"]';
// serial N of a stack holds its first N resources, so each version differs from the last
const STACKS = {
  network: [
    ["aws_vpc", "main"],
    ["aws_subnet", "a"],
    ["aws_subnet", "b"],
  ],
  app: [
    ["aws_ecs_cluster", "web"],
    ["aws_lb", "web"],
  ],
} as const;

/**
 * Fills a fresh backend (real API, throwaway database, mock GitLab) with a believable organization, and signs
 * its owner in. Starts the backend's worker: the first sync is applied by it, and so is any the demo starts.
 */
export async function seedDemo(backend: Backend) {
  const db = backend.t.db;
  const logger = createLogger({ level: "error", write: () => {} });
  backend.startWorker(undefined, {
    [DRIFT_CHECK_QUEUE]: driftCheckHandler({ db, keys: backend.keys, logger }),
  });
  const org = await backend.organization("Acme");
  const mock = backend.gitlab(undefined, ["api"]);
  const files = { "bun.lock": "", "package.json": "{}" };
  // the jobs of `JOBS`, in the stages their numbers name
  const ci = {
    ".gitlab-ci.yml": `stages: [build, test, verify, deploy]
build:
  stage: build
  script: [bun run build]
lint:
  stage: test
  script: [bun run lint]
test:
  stage: test
  script: [bun test]
e2e:
  stage: verify
  script: [bun run e2e]
deploy:
  stage: deploy
  script: [bun run deploy]
`,
  };
  const web = mock.addProject({
    path: "acme/web",
    defaultBranch: "main",
    files: { ...files, ...ci },
  });
  const api = mock.addProject({ path: "acme/api", defaultBranch: "main", files });
  // on GitLab but not imported, so the import page has something to offer
  const docs = mock.addProject({
    path: "acme/docs",
    defaultBranch: "main",
    files: { "README.md": "# docs" },
  });
  for (const p of [web, api, docs]) mock.addMember({ project: p.id }, mock.tokenUser.id, 40);

  const owner = await backend.signIn("Ada Lovelace", {
    orgRoles: { [org.id]: "owner" },
    projectRoles: {},
  });
  backend.makePlatformAdmin(owner.user.gitlabId);
  const o = owner.client.organizations({ orgId: org.id });

  const connection = must(
    await o.connections.post({
      type: "gitlab",
      name: "Acme GitLab",
      baseUrl: mock.url,
      token: mock.token,
    }),
  );
  must(
    await o
      .connections({ connectionId: connection.id })
      .imports.post({ gitlabProjectIds: [web.id, api.id] }),
  );
  // one project on GitHub, so the badges and the forge-neutral screens have something to show; the mock below is
  // GitHub's stand-in, nothing here reaches github.com
  const hub = backend.github(secretOf("github"));
  const mobile = hub.addRepo("acme", "mobile", { files: { "package.json": "{}", "bun.lock": "" } });
  const hubConnection = must(
    await o.connections.post({
      type: "github",
      name: "Acme GitHub",
      baseUrl: hub.url,
      token: secretOf("github"),
    }),
  );
  must(
    await o
      .connections({ connectionId: hubConnection.id })
      .imports.post({ gitlabProjectIds: [mobile.id] }),
  );
  const imported = must(await o.projects.get({ query: { limit: 100 } })).items;
  const idOf = (name: string) => {
    const found = imported.find((p) => p.name === name);
    if (!found) throw new Error(`the import did not make ${name}`);
    return found.id;
  };
  const projects = { web: idOf("acme/web"), api: idOf("acme/api"), mobile: idOf("acme/mobile") };
  const scope = o.projects({ projectId: projects.web });

  const envs: Record<string, string> = {};
  // in the order a build goes through them, which is the order of the Deployments card and what Promote offers first
  for (const [sortOrder, slug] of ENVIRONMENTS.entries())
    envs[slug] = must(await scope.environments.post({ name: slug, slug, sortOrder })).id;

  const secrets: string[] = [];
  const kind = (secret: boolean) => (secret ? "secret" : "plain") as "secret" | "plain";
  const put = async (
    key: string,
    value: string,
    secret: boolean,
    env?: string,
    tags?: string[],
    folder?: string,
  ) => {
    if (secret) secrets.push(value);
    const body = {
      key,
      kind: kind(secret),
      value,
      ...(tags ? { tags } : {}),
      ...(folder ? { folder } : {}),
    };
    const at = env ? scope.environments({ envId: envs[env] ?? "" }).variables : scope.variables;
    return must(await at.post(body));
  };
  must(await o.variables.post({ key: "SENTRY_DSN", kind: "secret", value: secretOf("sentry") }));
  secrets.push(secretOf("sentry"), secretOf("github"));
  const logLevel = await put("LOG_LEVEL", "info", false, undefined, ["logging"]);
  await put("API_URL", "https://api.acme.example", false, undefined, ["app", "public"]);
  for (const env of ENVIRONMENTS)
    await put("DATABASE_URL", secretOf(`database-${env}`), true, env, ["database"]);
  await put("FEATURE_FLAGS", "beta", false, "staging", ["app"]);
  // two folders of the project, so the Variables page shows folder rows; each has the database of its own service in dev
  for (const name of ["payments", "search"]) {
    must(await scope.folders.post({ parent: "/", name }));
    await put("DATABASE_URL", secretOf(`database-${name}`), true, "dev", ["database"], `/${name}`);
  }

  must(await o.pools.post({ name: "linux-runners", tags: ["linux", "docker"] }));

  // acme/web deploys with docker-deploy, and GitLab has deployments of it: read the way Refresh reads them
  await savePipelineConfig(db, {
    organizationId: org.id,
    projectId: projects.web,
    connectionId: connection.id,
    template: "docker-deploy",
    version: "1.0.0",
    renderedHash: "0".repeat(64),
  });
  for (const [environment, build, status, minutesAgo] of DEPLOYMENTS)
    mock.addDeployment(web.path, {
      environment,
      sha: build.padEnd(40, "0"),
      status,
      at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    });
  must(await scope.deployments.refresh.post());

  // pipelines of the mock GitLab, so that a failed or canceled run can really be retried from the page
  const gitlab = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const branches = new Set(["main"]);
  for (const [i, p] of PIPELINES.entries()) {
    if (!branches.has(p.ref)) {
      branches.add(p.ref);
      await gitlab.repository.createBranch(web.id, p.ref, "main");
    }
    const pipeline = await gitlab.pipelines.trigger(web.id, p.ref);
    if (p.status === "failed") mock.finishPipeline(pipeline.id, "failed", p.why[0]);
    if (p.status === "success") mock.finishPipeline(pipeline.id, "success");
    // one job at a time, each starting where the one before ended, the last one `minutesAgo` before it was seen
    const states = jobStates(p);
    const ran = (i: number) => (["success", "failed"].includes(states[i] ?? "") ? 1 : 0);
    let clock =
      Date.now() -
      (p.minutesAgo * 60 + JOBS.reduce((sum, [, , seconds], i) => sum + seconds * ran(i), 0)) *
        1000;
    for (const [i, [name, , seconds]] of JOBS.entries()) {
      const state = states[i];
      if (!state) continue;
      mock.setJobStatus(pipeline.id, name, state, p.status === "failed" ? p.why[0] : undefined);
      if (!ran(i)) continue;
      // the mock's clock is the test's; these are the demo's, so each job has a believable time
      const times = { started_at: new Date(clock).toISOString(), duration: seconds };
      clock += seconds * 1000;
      mock.addJobFields(pipeline.id, name, {
        ...times,
        finished_at: new Date(clock).toISOString(),
      });
    }
    // the newest main pipeline starts a pipeline of the same project that has passed, its jobs following the parent's last
    // (not recorded as a run of its own: Status lists a branch's pipelines, and the drawing shows this one under its parent)
    if (p.ref === "main" && p.status === "success") {
      const child = mock.addDownstream(
        pipeline.id,
        "release",
        CHILD_JOBS.map(([name]) => name),
        { stage: "deploy" },
      );
      mock.finishPipeline(child, "success");
      for (const [name, seconds] of CHILD_JOBS) {
        const started_at = new Date(clock).toISOString();
        clock += seconds * 1000;
        mock.addJobFields(child, name, {
          started_at,
          duration: seconds,
          finished_at: new Date(clock).toISOString(),
        });
      }
    }
    // and hands over to acme/api, which is imported: that project's pipeline is recorded as a run of it, so the drawing can
    // follow the trigger into it (it is acme/api's row on its own Status, not acme/web's)
    if (p.ref === "main" && p.status === "success") {
      const handover = mock.addDownstream(
        pipeline.id,
        "deploy-api",
        HANDOVER_JOBS.map(([name]) => name),
        { stage: "deploy", project: "acme/api" },
      );
      mock.finishPipeline(handover, "success");
      let at = clock;
      for (const [name, seconds] of HANDOVER_JOBS) {
        const started_at = new Date(at).toISOString();
        at += seconds * 1000;
        // a job of the mock's downstream pipeline is in its `test` stage unless it is told otherwise
        mock.addJobFields(handover, name, {
          stage: "deploy",
          started_at,
          duration: seconds,
          finished_at: new Date(at).toISOString(),
        });
      }
      await recordPipelineRun(db, {
        organizationId: org.id,
        projectId: projects.api,
        connectionId: connection.id,
        gitlabPipelineId: handover,
        iid: 1,
        ref: p.ref,
        status: "success",
        sha: "c0ffee1234567890".padEnd(40, "0"),
        webUrl: `${mock.url}/acme/api/-/pipelines/${handover}`,
        failureReason: null,
        failedJob: null,
        observedAt: new Date(Date.now() - p.minutesAgo * 60_000),
      });
    }
    if (p.status === "canceled") await gitlab.pipelines.cancel(web.id, pipeline.id);
    await recordPipelineRun(db, {
      organizationId: org.id,
      projectId: projects.web,
      connectionId: connection.id,
      gitlabPipelineId: pipeline.id,
      iid: i + 1,
      ref: p.ref,
      status: p.status,
      sha: "c0ffee1234567890".padEnd(40, "0"),
      webUrl: `${mock.url}/acme/web/-/pipelines/${pipeline.id}`,
      failureReason: p.status === "failed" ? p.why[0] : null,
      failedJob: p.status === "failed" ? p.why[1] : null,
      observedAt: new Date(Date.now() - p.minutesAgo * 60_000),
    });
  }

  for (const [stackName, resources] of Object.entries(STACKS)) {
    for (let serial = 1; serial <= resources.length; serial++) {
      const content = JSON.stringify({
        version: 4,
        serial,
        lineage: `demo-${stackName}`,
        outputs: {},
        resources: resources.slice(0, serial).map(([type, name]) => ({
          mode: "managed",
          type,
          name,
          provider: AWS,
          instances: [{ schema_version: 0, attributes: { id: `demo-${type}-${name}` } }],
        })),
      });
      const parsed = parseStateResources(JSON.parse(content));
      if (!parsed.ok) throw new Error("the demo's state is not state");
      const stored = await putState(
        db,
        backend.keys,
        { organizationId: org.id, projectId: projects.web, stackName },
        {
          serial,
          lineage: `demo-${stackName}`,
          content,
          createdBy: `ci:job-${serial}`,
          resources: parsed.resources,
        },
      );
      if (!stored.ok) throw new Error(`the demo's state was refused: ${stored.reason}`);
    }
  }

  await upsertFindings(db, {
    organizationId: org.id,
    projectId: projects.web,
    ref: "main",
    findings: [
      {
        fingerprint: "demo-1",
        rule: "aws-access-token",
        path: "src/config.ts",
        line: 7,
        commit: "a1b2c3d4e5f6",
        severity: "critical",
      },
      {
        fingerprint: "demo-2",
        rule: "gitlab-pat",
        path: "ci/deploy.sh",
        line: null,
        commit: "a1b2c3d4e5f6",
        severity: "high",
      },
      {
        fingerprint: "demo-3",
        rule: "generic-api-key",
        path: "scripts/seed.ts",
        line: 31,
        commit: "a1b2c3d4e5f6",
        severity: "medium",
      },
      {
        fingerprint: "demo-4",
        rule: "private-key",
        path: "test/fixtures/key.txt",
        line: 1,
        commit: "a1b2c3d4e5f6",
        severity: "low",
      },
    ],
  });

  // the project's variables, synced to the CI/CD variables of the same project on the mock GitLab: applied once,
  // then one value changes, and the drift check (the real one, run by the worker) finds it
  const target = must(
    await scope["sync-targets"].post({
      name: "acme-web-ci",
      type: "gitlab-variables",
      connectionId: connection.id,
      // a production secret may only go to a target that protects its variables (the guardrail says so)
      config: { project: "acme/web", protected: true },
      environmentMapping: { dev: "development", staging: "staging", production: "production" },
    }),
  );
  const at = scope["sync-targets"]({ targetId: target.id });
  must(await at.apply.post({ planId: must(await at.plan.post()).id }));
  await until(
    "the first sync",
    async () => must(await at["last-run"].get()).run?.status === "applied",
  );
  must(await scope.variables({ varId: logLevel.id }).patch({ value: "debug" }));
  await queueDriftChecks(db);
  await until("the drift check", async () => must(await at.drift.get()).status === "drifted");

  return {
    org,
    owner,
    mock,
    web: projects.web,
    api: projects.api,
    /** The project on GitHub, and the mock GitHub it was imported from. */
    mobile: projects.mobile,
    hub,
    envs,
    secrets,
    /** Asks the worker for a drift check of every target, as the schedule does on a real deployment. */
    checkDrift: () => queueDriftChecks(db),
  };
}
export type Demo = Awaited<ReturnType<typeof seedDemo>>;

/**
 * A fresh session for the demo's owner, set by one click on a link: no GitLab sign-in happens, so this is only
 * ever served on loopback (server.ts), to a database that holds nothing real.
 */
export async function signInAs(backend: Backend, demo: Demo, to: string) {
  const token = randomToken();
  await createSession(backend.t.db, {
    userId: demo.owner.user.id,
    tokenHash: hashToken(token),
    ttlMs: SESSION_MS,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: to,
      "set-cookie": `orch_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`,
    },
  });
}
