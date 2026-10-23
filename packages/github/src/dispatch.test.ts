import { afterEach, describe, expect, test } from "bun:test";
import { GitlabError } from "@orch/gitlab";
import { createGithubClient } from "./client";
import { createMockGithub } from "./mock/server";
import { pipelinesApi } from "./pipelines";
import { repoBase } from "./projects";

// FRG-30: a workflow is started by a dispatch, which answers no run id; the run is found afterwards by its name.

let mock: ReturnType<typeof createMockGithub>;
afterEach(() => mock?.stop());

const FILE = ".github/workflows/orch-stacks.yml";
const WORKFLOW = `name: Orch stacks
run-name: orch \${{ inputs.run_id }} \${{ inputs.action }}
on:
  workflow_dispatch:
    inputs:
      run_id:
        required: true
      action:
        type: choice
        options: [plan, apply]
        default: plan
jobs: {}
`;
const PLAIN = "name: Plain\non: workflow_dispatch\njobs: {}\n";
const PUSH_ONLY = "name: Push\non: push\njobs: {}\n";

function setup(opts: Parameters<typeof createMockGithub>[0] = {}) {
  mock?.stop();
  mock = createMockGithub(opts);
  mock.addRepo("acme", "svc", {
    files: {
      "README.md": "x",
      [FILE]: WORKFLOW,
      ".github/workflows/plain.yml": PLAIN,
      ".github/workflows/push.yml": PUSH_ONLY,
    },
  });
  const client = createGithubClient({
    baseUrl: mock.url,
    allowInsecureHttp: true,
    token: "ghp_not-a-real-token-1234",
    maxRetries: 0,
  });
  const api = pipelinesApi(client, repoBase(client), { attempts: 4, delayMs: 0 });
  const asked = () => mock.requests.map((r) => `${r.method} ${r.path}`);
  const dispatch = (file: string, body: unknown) =>
    client.request("POST", `/repos/acme/svc/actions/workflows/${file}/dispatches`, { body });
  const listed = (file = "orch-stacks.yml", query: Record<string, string> = {}) =>
    client.request<{ total_count: number; workflow_runs: Record<string, unknown>[] }>(
      "GET",
      `/repos/acme/svc/actions/workflows/${file}/runs`,
      { query },
    );
  return { ...api, client, asked, dispatch, listed, ref: "acme/svc" };
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as GitlabError;
  }
  throw new Error("expected a failure");
};

describe("the mock's dispatch is as strict as GitHub's", () => {
  test("a dispatch answers with no run, and the run is listed under the workflow's run-name", async () => {
    const { dispatch, listed } = setup();
    expect(await dispatch("orch-stacks.yml", { ref: "main", inputs: { run_id: "r1" } })).toBe(
      undefined,
    );
    const { workflow_runs, total_count } = await listed("orch-stacks.yml", {
      event: "workflow_dispatch",
    });
    expect(total_count).toBe(1);
    expect(workflow_runs[0]).toMatchObject({
      display_title: "orch r1 plan",
      event: "workflow_dispatch",
      status: "queued",
      head_branch: "main",
      path: FILE,
    });
    expect(String(workflow_runs[0]?.head_sha)).toMatch(/^[0-9a-f]{40}$/);
  });

  test("the run-name takes the inputs as given; a workflow with none is titled by its name", async () => {
    const { dispatch, listed } = setup();
    await dispatch("orch-stacks.yml", { ref: "main", inputs: { run_id: "r2", action: "apply" } });
    await dispatch("plain.yml", { ref: "main" });
    expect((await listed()).workflow_runs[0]?.display_title).toBe("orch r2 apply");
    expect((await listed("plain.yml")).workflow_runs[0]?.display_title).toBe("Plain");
  });

  test.each([
    [
      "an input the workflow does not declare",
      { ref: "main", inputs: { run_id: "r", other: "x" } },
    ],
    ["a required input left out", { ref: "main", inputs: { action: "plan" } }],
    ["a choice that is not an option", { ref: "main", inputs: { run_id: "r", action: "destroy" } }],
    ["a value that is not a string", { ref: "main", inputs: { run_id: 7 } }],
    ["a ref that does not exist", { ref: "nope", inputs: { run_id: "r" } }],
  ])("%s is a 422, and no run is made", async (_, body) => {
    const { dispatch, listed } = setup();
    const e = await failure(dispatch("orch-stacks.yml", body));
    expect(e.kind).toBe("invalid");
    expect((await listed()).total_count).toBe(0);
  });

  test("a workflow that is not in the repository at that ref is a 404; one without workflow_dispatch is a 422", async () => {
    const { dispatch } = setup();
    expect((await failure(dispatch("missing.yml", { ref: "main" }))).kind).toBe("not_found");
    expect((await failure(dispatch("push.yml", { ref: "main" }))).kind).toBe("invalid");
  });

  test("runs of other events and branches are not in a filtered list, and the newest comes first", async () => {
    const { dispatch, listed } = setup();
    mock.addRun("acme", "svc", { title: "pushed", event: "push", workflow: "orch-stacks.yml" });
    await dispatch("orch-stacks.yml", { ref: "main", inputs: { run_id: "a" } });
    await dispatch("orch-stacks.yml", { ref: "main", inputs: { run_id: "b" } });
    const titles = (q: Record<string, string>) =>
      listed("orch-stacks.yml", q).then((l) => l.workflow_runs.map((r) => r.display_title));
    expect(await titles({ event: "workflow_dispatch" })).toEqual(["orch b plan", "orch a plan"]);
    expect(await titles({ event: "push" })).toEqual(["pushed"]);
    expect(await titles({ branch: "other" })).toEqual([]);
    expect(await titles({})).toEqual(["orch b plan", "orch a plan", "pushed"]);
  });

  test("a run can be held back from the list for a few reads, as GitHub is slow to show one", async () => {
    const { dispatch, listed } = setup({ runAppearsAfter: 2 });
    await dispatch("orch-stacks.yml", { ref: "main", inputs: { run_id: "a" } });
    expect((await listed()).total_count).toBe(0);
    expect((await listed()).total_count).toBe(0);
    expect((await listed()).total_count).toBe(1);
  });
});

describe("startRun: dispatch, then find the run by its name", () => {
  const run = (name: string, inputs: Record<string, string>) => ({
    workflow: "orch-stacks.yml",
    ref: "main",
    inputs,
    name,
  });

  test("the run it started is returned, as a pipeline, after a look before and a look after", async () => {
    const { startRun, asked } = setup();
    const p = await startRun("acme/svc", run("orch r1 apply", { run_id: "r1", action: "apply" }));
    expect(p).toMatchObject({ status: "pending", ref: "main" });
    expect(p.webUrl).toContain(`/actions/runs/${p.id}`);
    const base = "/repos/acme/svc/actions";
    expect(asked()).toEqual([
      `GET ${base}/workflows/orch-stacks.yml/runs`,
      `POST ${base}/workflows/orch-stacks.yml/dispatches`,
      `GET ${base}/workflows/orch-stacks.yml/runs`,
      `GET ${base}/runs/${p.id}`,
    ]);
    // only dispatched runs are looked at: a run of another event with the same name is not the one
    const lists = mock.requests.filter((r) => r.path.endsWith("/runs"));
    expect(lists.map((r) => r.query.get("event"))).toEqual([
      "workflow_dispatch",
      "workflow_dispatch",
    ]);
  });

  test("two runs started at once each find their own", async () => {
    const { startRun, listed } = setup();
    const [a, b] = await Promise.all([
      startRun("acme/svc", run("orch ra plan", { run_id: "ra" })),
      startRun("acme/svc", run("orch rb plan", { run_id: "rb" })),
    ]);
    const title = new Map((await listed()).workflow_runs.map((r) => [r.id, r.display_title]));
    expect(title.get(a.id)).toBe("orch ra plan");
    expect(title.get(b.id)).toBe("orch rb plan");
  });

  test("an older run with the same name is not taken for the new one", async () => {
    const { startRun } = setup();
    const old = mock.addRun("acme", "svc", {
      title: "orch r1 apply",
      event: "workflow_dispatch",
      workflow: "orch-stacks.yml",
      status: "completed",
      conclusion: "success",
    });
    const p = await startRun("acme/svc", run("orch r1 apply", { run_id: "r1", action: "apply" }));
    expect(p.id).not.toBe(old.id);
    expect(p.status).toBe("pending");
  });

  test("a run GitHub shows late is waited for", async () => {
    const { startRun, asked } = setup({ runAppearsAfter: 2 });
    const p = await startRun("acme/svc", run("orch r1 plan", { run_id: "r1" }));
    expect(p.status).toBe("pending");
    expect(asked().filter((r) => r.endsWith("/runs"))).toHaveLength(4);
  });

  test("a run that never shows is an error that says the dispatch may have started one", async () => {
    const { startRun } = setup({ runAppearsAfter: 50 });
    const e = await failure(startRun("acme/svc", run("orch r1 plan", { run_id: "r1" })));
    expect(e).toBeInstanceOf(GitlabError);
    // the outcome is unknown, which is what `timeout` says
    expect(e.kind).toBe("timeout");
    expect(e.message).toContain("orch r1 plan");
    expect(e.message).toContain("may have started");
  });

  test("two new runs with the name are refused, not one picked", async () => {
    const { startRun } = setup({ alsoDispatches: true });
    const e = await failure(startRun("acme/svc", run("orch r1 plan", { run_id: "r1" })));
    expect(e.message).toContain("more than one");
  });

  test("GitHub refusing the dispatch is the error, and nothing is polled", async () => {
    const { startRun, asked } = setup();
    const e = await failure(
      startRun("acme/svc", run("orch r1 plan", { run_id: "r1", other: "x" })),
    );
    expect(e.kind).toBe("invalid");
    expect(asked().filter((r) => r.startsWith("GET"))).toHaveLength(1);
  });

  test("a list that cannot be read stops before the dispatch: the run could not be told from another", async () => {
    const { startRun, asked } = setup({ denied: ["/actions/workflows/orch-stacks.yml/runs"] });
    const e = await failure(startRun("acme/svc", run("orch r1 plan", { run_id: "r1" })));
    expect(e).toBeInstanceOf(GitlabError);
    expect(asked().some((r) => r.startsWith("POST"))).toBe(false);
  });

  test.each([
    ["a path", { workflow: "../x.yml" }],
    ["a folder", { workflow: "a/b.yml" }],
    ["no file name", { workflow: "" }],
    ["a file that is no workflow", { workflow: "orch-stacks.sh" }],
    ["no ref", { ref: "" }],
    ["no name", { name: "" }],
  ])("%s is refused before anything is sent", async (_, over) => {
    const { startRun, asked } = setup();
    const e = await failure(
      startRun("acme/svc", { ...run("orch r1 plan", { run_id: "r1" }), ...over }),
    );
    expect(e.kind).toBe("invalid");
    expect(asked()).toEqual([]);
  });
});
