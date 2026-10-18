import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { generatePipeline, type PlanInput } from "./pipeline-gen";
import type { Stack } from "./scan";

// IAC-10: the generated jobs reach GitLab-managed Terraform state. A fake of GitLab's state API
// stands in for GitLab; the jobs' own variables and script lines are what talk to it.

const TOKEN = "glcbt-canary-job-token-0123456789";
const PROJECT = "42";

const stack = (name: string, over: Partial<Stack> = {}): Stack => ({
  name,
  path: `stacks/${name}`,
  tool: "terraform",
  version: "1.9.8",
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "http",
  ...over,
});

const plan = (stacks: Stack[], select = stacks.map((s) => s.name)): PlanInput => ({
  action: "plan",
  stacks,
  select,
  audience: "orch.example.com",
  apiUrl: "https://orch.example.com",
  summaryPath: "/runs/0b9e5bd2/plan-summary",
  helperImage: "registry.example.com/orch/ci-helper:1.0.0",
  images: { terragrunt: "example.com/terragrunt" },
});

// biome-ignore lint/suspicious/noExplicitAny: a job read back from YAML, looked into loosely by the tests
type Job = Record<string, any>;
const jobsOf = (yaml: string): Record<string, Job> => {
  const { stages: _, ...jobs } = parse(yaml);
  return jobs;
};

interface Hit {
  method: string;
  path: string;
  user: string;
  password: string;
}

/** GitLab's state API as far as Terraform's `http` backend uses it: state, and lock as POST/DELETE. */
function fakeGitlab() {
  const states = new Map<string, string>();
  const locks = new Map<string, string>();
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      const [user = "", password = ""] = auth.startsWith("Basic ")
        ? atob(auth.slice(6)).split(":")
        : [];
      hits.push({ method: req.method, path: url.pathname, user, password });
      if (user !== "gitlab-ci-token" || password !== TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      const m = new RegExp(
        `^/api/v4/projects/${PROJECT}/terraform/state/([a-z0-9-]+)(/lock)?$`,
      ).exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const name = m[1] as string;
      if (m[2]) {
        if (req.method === "POST") {
          const held = locks.get(name);
          if (held !== undefined) return new Response(held, { status: 409 });
          locks.set(name, await req.text());
          return new Response("ok");
        }
        if (req.method === "DELETE") {
          locks.delete(name);
          return new Response("ok");
        }
        return new Response("method not allowed", { status: 405 });
      }
      if (req.method === "GET") {
        const state = states.get(name);
        return state === undefined ? new Response("", { status: 404 }) : new Response(state);
      }
      if (req.method === "POST") {
        states.set(name, await req.text());
        return new Response("ok");
      }
      return new Response("method not allowed", { status: 405 });
    },
  });
  return {
    states,
    locks,
    hits,
    apiUrl: `http://127.0.0.1:${server.port}/api/v4`,
    stop: () => server.stop(true),
  };
}

let gitlab: ReturnType<typeof fakeGitlab>;
beforeAll(() => {
  gitlab = fakeGitlab();
});
afterAll(() => gitlab.stop());

/** What GitLab fills in for a job: only the variables the settings are allowed to name. */
const resolve = (value: string) =>
  value.replace(/\$([A-Z0-9_]+)/g, (_, name: string) => {
    const known: Record<string, string> = {
      CI_API_V4_URL: gitlab.apiUrl,
      CI_PROJECT_ID: PROJECT,
      CI_JOB_TOKEN: TOKEN,
    };
    const v = known[name];
    if (v === undefined)
      throw new Error(`the job names $${name}, which GitLab does not set for it`);
    return v;
  });
const envOf = (job: Job): Record<string, string> =>
  Object.fromEntries(Object.entries(job.variables ?? {}).map(([k, v]) => [k, resolve(String(v))]));

const STACKS = [stack("net", { path: "infra/network" }), stack("app", { dependsOn: ["net"] })];

describe("state settings in the generated jobs", () => {
  const jobs = jobsOf(generatePipeline(plan(STACKS)));
  const state = (name: string) => `$CI_API_V4_URL/projects/$CI_PROJECT_ID/terraform/state/${name}`;

  test("a stack's plan and apply jobs read and lock the state named after the stack, not its path", () => {
    const apply = jobsOf(
      generatePipeline({
        action: "apply",
        stacks: STACKS,
        select: ["app", "net"],
        planJobs: { app: 2, net: 1 },
      }),
    );
    for (const job of [jobs["plan:net"], apply["apply:net"]]) {
      expect(job?.variables).toEqual({
        TF_HTTP_ADDRESS: state("net"),
        TF_HTTP_LOCK_ADDRESS: `${state("net")}/lock`,
        TF_HTTP_LOCK_METHOD: "POST",
        TF_HTTP_UNLOCK_ADDRESS: `${state("net")}/lock`,
        TF_HTTP_UNLOCK_METHOD: "DELETE",
        TF_HTTP_USERNAME: "gitlab-ci-token",
        TF_HTTP_PASSWORD: "$CI_JOB_TOKEN",
        TF_HTTP_RETRY_WAIT_MIN: "5",
      });
    }
    expect(jobs["plan:app"]?.variables.TF_HTTP_ADDRESS).toBe(state("app"));
    expect(apply["apply:app"]?.variables.TF_HTTP_ADDRESS).toBe(state("app"));
  });

  test("the summary job, which holds the platform's token, has no state settings", () => {
    expect(Object.keys(jobs["summary:net"]?.variables ?? {})).toEqual(["ORCH_API_URL"]);
  });

  test("no value is a secret: the token is a reference to the job's own, and nothing else is referenced", () => {
    const values = Object.values(jobs).flatMap((j) => Object.values(j.variables ?? {}) as string[]);
    expect(values.length).toBeGreaterThan(0);
    const named = new Set(
      values.flatMap((v) => [...v.matchAll(/\$([A-Z0-9_]+)/g)].map((m) => m[1])),
    );
    expect([...named].sort()).toEqual(["CI_API_V4_URL", "CI_JOB_TOKEN", "CI_PROJECT_ID"]);
    expect(values.filter((v) => v.includes("CI_JOB_TOKEN"))).toEqual(
      values.filter((v) => v === "$CI_JOB_TOKEN"),
    );
  });

  test("a stack that declares a backend of its own is passed through; the others keep theirs", () => {
    const yaml = generatePipeline(plan([...STACKS, stack("data", { backend: "other" })]));
    const all = jobsOf(yaml);
    expect(all["plan:data"]).toBeDefined();
    expect(all["plan:data"]).not.toHaveProperty("variables");
    expect(all["plan:data"]?.script).toContain("terraform init -input=false");
    expect(yaml).not.toContain("terraform/state/data");
    expect(all["plan:net"]?.variables.TF_HTTP_ADDRESS).toBe(state("net"));
  });

  test("a stack whose backend is not known (Terragrunt) gets the settings; one that declares none does not", () => {
    const all = jobsOf(
      generatePipeline(
        plan([
          stack("tg", { tool: "terragrunt", backend: "unchecked" }),
          stack("local", { backend: "none" }),
        ]),
      ),
    );
    expect(all["plan:tg"]?.variables.TF_HTTP_ADDRESS).toBe(state("tg"));
    expect(all["plan:local"]).not.toHaveProperty("variables");
  });
});

describe("against a fake GitLab state API", () => {
  const jobs = jobsOf(generatePipeline(plan(STACKS)));

  /** What the Terraform `http` backend does with these settings: read, lock, write, unlock. */
  async function backend(env: Record<string, string>, lockId: string) {
    const auth = {
      authorization: `Basic ${btoa(`${env.TF_HTTP_USERNAME}:${env.TF_HTTP_PASSWORD}`)}`,
    };
    const call = (method: string | undefined, url: string | undefined, body?: string) =>
      fetch(url as string, { method, headers: auth, body });
    const read = () => call("GET", env.TF_HTTP_ADDRESS);
    const lock = () =>
      call(env.TF_HTTP_LOCK_METHOD, env.TF_HTTP_LOCK_ADDRESS, JSON.stringify({ ID: lockId }));
    const write = (state: string) => call("POST", `${env.TF_HTTP_ADDRESS}?ID=${lockId}`, state);
    const unlock = () =>
      call(env.TF_HTTP_UNLOCK_METHOD, env.TF_HTTP_UNLOCK_ADDRESS, JSON.stringify({ ID: lockId }));
    return { read, lock, write, unlock };
  }

  test("the settings read, lock, write and unlock the stack's own state", async () => {
    const net = await backend(envOf(jobs["plan:net"] as Job), "run-1");
    expect((await net.read()).status).toBe(404); // no state yet: an empty one
    expect((await net.lock()).status).toBe(200);
    expect((await net.write('{"serial":1}')).status).toBe(200);
    expect((await net.unlock()).status).toBe(200);
    expect(gitlab.states.get("net")).toBe('{"serial":1}');
    expect(gitlab.locks.size).toBe(0);
    expect(gitlab.states.has("app")).toBe(false);
  });

  test("one stack's lock holds off its own next run but not another stack", async () => {
    const first = await backend(envOf(jobs["plan:net"] as Job), "a");
    const second = await backend(envOf(jobs["plan:net"] as Job), "b");
    const other = await backend(envOf(jobs["plan:app"] as Job), "c");
    expect((await first.lock()).status).toBe(200);
    expect((await second.lock()).status).toBe(409);
    expect((await other.lock()).status).toBe(200);
    await first.unlock();
    await other.unlock();
    expect((await second.lock()).status).toBe(200);
    await second.unlock();
  });

  test("the job's own token is the only credential, and a wrong one is refused", async () => {
    const env = envOf(jobs["plan:net"] as Job);
    expect(env.TF_HTTP_PASSWORD).toBe(TOKEN);
    expect((await (await backend({ ...env, TF_HTTP_PASSWORD: "other" }, "x")).read()).status).toBe(
      401,
    );
  });
});

const terraform = Bun.which("terraform");

describe.skipIf(!terraform)("with the real terraform", () => {
  let dir = "";
  beforeAll(async () => {
    // the protocol tests above left a made-up state behind: terraform starts from none
    gitlab.states.clear();
    gitlab.locks.clear();
    dir = await mkdtemp(join(tmpdir(), "orch-state-"));
    // terraform_data is built in: init needs no provider and no network
    await mkdir(join(dir, "stacks/net"), { recursive: true });
    await writeFile(
      join(dir, "stacks/net/main.tf"),
      'terraform {\n  backend "http" {}\n}\nresource "terraform_data" "x" {\n  input = "a"\n}\n',
    );
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** Runs a generated job's script as the runner would, minus the plan fetch (the plan is here). */
  async function run(job: Job) {
    const script = (job.script as string[]).filter((l) => !l.startsWith("wget ")).join("\n");
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      CHECKPOINT_DISABLE: "1",
      TF_IN_AUTOMATION: "1",
      ...envOf(job),
    };
    const proc = Bun.spawn(["sh", "-ec", script], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw new Error(`the job failed (${code}):\n${out}\n${err}`);
  }

  test("a generated plan and apply init against the backend and take and release its lock", async () => {
    const stacks = [stack("net")];
    const planJobs = jobsOf(generatePipeline(plan(stacks)));
    const applyJobs = jobsOf(
      generatePipeline({ action: "apply", stacks, select: ["net"], planJobs: { net: 1 } }),
    );
    gitlab.hits.length = 0;
    await run(planJobs["plan:net"] as Job);
    await run(applyJobs["apply:net"] as Job);

    const seen = gitlab.hits.map((h) => `${h.method} ${h.path.split("/state/")[1]}`);
    expect(seen).toContain("GET net");
    expect(seen).toContain("POST net/lock");
    expect(seen).toContain("DELETE net/lock");
    expect(seen).toContain("POST net");
    // every lock was released, and the state the apply wrote is the stack's
    expect(seen.filter((s) => s === "POST net/lock").length).toBe(
      seen.filter((s) => s === "DELETE net/lock").length,
    );
    expect(gitlab.locks.size).toBe(0);
    expect(gitlab.states.get("net")).toContain("terraform_data");
    expect(gitlab.hits.every((h) => h.user === "gitlab-ci-token" && h.password === TOKEN)).toBe(
      true,
    );
  }, 60_000);
});
