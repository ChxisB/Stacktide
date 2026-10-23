import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createProject,
  createRun,
  moveRunStack,
  type NewPipelineRun,
  type NewStack,
  projects,
  recordPipelineRun,
  storePlanSummary,
  storePolicyVerdict,
  syncStacks,
} from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eq } from "drizzle-orm";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { OrgProvider, RequireOrg } from "./org";
import { RunsPage } from "./runs";
import { type Backend, clientVia, down, mount, pathOf, startBackend, visibleText } from "./testing";
import { must, scene as sceneOn } from "./variables.fixture";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/status";
  try {
    localStorage.clear();
  } catch {
    // the page copes without it
  }
});

type Scene = Awaited<ReturnType<typeof sceneOn>>;
let id = 1000;
/** A run of GitLab's, as the worker stores it, for the scene's project. */
const run = (
  s: Scene,
  over: Partial<NewPipelineRun> & { status: string; ref: string },
): Promise<unknown> => {
  const gitlabPipelineId = ++id;
  return recordPipelineRun(backend.t.db, {
    organizationId: s.org.id,
    projectId: s.project.id,
    connectionId: null,
    gitlabPipelineId,
    iid: gitlabPipelineId - 1000,
    sha: "c0ffee1234567890".padEnd(40, "0"),
    webUrl: `https://gitlab.example/acme/web/-/pipelines/${gitlabPipelineId}`,
    failureReason: null,
    failedJob: null,
    observedAt: new Date(),
    ...over,
  });
};
const latest = async (s: Scene) =>
  must(await s.scope["pipeline-runs"].latest.get({ query: { limit: 50 } })).runs;

/** The scene's project on a GitLab project of the mock, with a connection that reaches it and one failed run. */
async function live(s: Scene, ci = "test:\n  script:\n    - echo hi\n") {
  const mock = backend.gitlab(undefined, ["api"]);
  const gl = mock.addProject({
    path: `fx/runs-${++id}`,
    files: { ".gitlab-ci.yml": ci },
  });
  mock.addMember({ project: gl.id }, mock.tokenUser.id, 40);
  await backend.t.db
    .update(projects)
    .set({ gitlabProjectId: gl.id })
    .where(eq(projects.id, s.project.id));
  const connection = must(
    await s.admin.client.organizations({ orgId: s.org.id }).connections.post({
      type: "gitlab",
      name: "Mock GitLab",
      baseUrl: mock.url,
      token: mock.token,
    }),
  );
  const gitlab = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const pipelineId = (await gitlab.pipelines.trigger(gl.id, "main")).id;
  mock.finishPipeline(pipelineId, "failed");
  await run(s, {
    status: "failed",
    ref: "main",
    gitlabPipelineId: pipelineId,
    connectionId: connection.id,
    failureReason: "script_failure",
    failedJob: "test",
  });
  const retries = () =>
    mock.requests.filter((r) => r.method === "POST" && /\/retry$/.test(r.path)).length;
  return { mock, gl, retries, pipelineId, connectionId: connection.id };
}

/** The scene's client, with the chance to answer a request instead of the API. */
const via = (
  s: Scene,
  hook: (request: Request, path: string) => Response | undefined | Promise<Response | undefined>,
) =>
  clientVia(
    backend.api,
    s.cookie,
    async (request, send) => (await hook(request, pathOf(request))) ?? send(),
  );

function mountPage(client: ReturnType<Backend["anonymous"]>, pollMs?: number) {
  render(
    <Providers client={client} queries={newQueryClient()}>
      <AuthGate>
        <OrgProvider>
          <RequireOrg>
            {(org) => <RunsPage orgId={org.id} {...(pollMs ? { pollMs } : {})} />}
          </RequireOrg>
        </OrgProvider>
      </AuthGate>
    </Providers>,
  );
}

// a role query is slow in happy-dom, and a slow one inside a wait starves the polling it waits for
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? undefined;
const statusText = () => document.querySelector('[role="status"]')?.textContent ?? undefined;
const table = () => screen.findByRole("table", { name: "Latest pipeline of each branch" });
const rowOf = (t: HTMLElement, branch: string) => {
  const tr = within(t).getByRole("rowheader", { name: branch }).closest("tr");
  if (!tr) throw new Error(`no row for ${branch}`);
  return tr;
};
const cells = (tr: HTMLElement) =>
  Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? "");

describe("the page", () => {
  test("is in the navigation, and says so when no pipeline has run", async () => {
    const s = await sceneOn(backend);
    mount(s.client);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Status" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Pipeline status");
    await screen.findByText(/No pipeline has run for this project yet/);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("link", { name: "Pipeline page" }).getAttribute("href")).toBe(
      "#/pipeline",
    );
  });

  test("shows the newest pipeline of each branch, newest first", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    await run(s, { status: "failed", ref: "dev" });
    await run(s, { status: "running", ref: "main" });
    await run(s, { status: "success", ref: "dev" });
    await run(s, { status: "failed", ref: "feature", failureReason: "script_failure" });
    mountPage(s.client);
    const t = await table();
    expect(
      within(t)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["feature", "dev", "main"]);
    expect(within(rowOf(t, "feature")).getByText("Failed")).toBeDefined();
    expect(within(rowOf(t, "dev")).getByText("Passed")).toBeDefined();
    expect(within(rowOf(t, "main")).getByText("Running")).toBeDefined();
    // the commit is short, the time is the platform's last look at GitLab
    const [, commit, , checked] = cells(rowOf(t, "main"));
    expect(commit).toBe("c0ffee12");
    expect(checked).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
  });

  test("the runs sit in a card, so a narrow screen scrolls the table and not the page", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    mountPage(s.client);
    const t = await table();
    const card = within(document.body).getByRole("region", { name: "Latest pipelines" });
    expect(card.classList.contains("card")).toBe(true);
    expect(card.contains(t)).toBe(true);
    expect(card.textContent).toContain("The newest pipeline of each branch.");
  });

  test("each of GitLab's statuses reads in words, as the kind of news it is", async () => {
    const s = await sceneOn(backend);
    const statuses: [string, string, string][] = [
      ["success", "Passed", "ok"],
      ["failed", "Failed", "bad"],
      ["running", "Running", "active"],
      ["pending", "Pending", "active"],
      ["created", "Created", "active"],
      ["preparing", "Preparing", "active"],
      ["waiting_for_resource", "Waiting for a resource", "active"],
      ["scheduled", "Scheduled", "active"],
      ["canceling", "Canceling", "active"],
      ["canceled", "Canceled", "quiet"],
      ["skipped", "Skipped", "quiet"],
      ["manual", "Waiting for a manual step", "quiet"],
      // one this version has never heard of
      ["brand_new_status", "brand new status", "quiet"],
    ];
    for (const [status] of statuses) await run(s, { status, ref: `on-${status}` });
    mountPage(s.client);
    const t = await table();
    for (const [status, label, tone] of statuses) {
      const tag = within(rowOf(t, `on-${status}`)).getByText(label);
      // the badge: `st` and its tone, its words, and a shape that is not read out
      expect([status, tag.className]).toEqual([status, `st st-${tone}`]);
      expect(tag.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("a failed pipeline says why, in words, and in which job", async () => {
    const s = await sceneOn(backend);
    await run(s, {
      status: "failed",
      ref: "a",
      failureReason: "script_failure",
      failedJob: "test",
    });
    await run(s, { status: "failed", ref: "b", failureReason: "stuck_or_timeout_failure" });
    await run(s, { status: "failed", ref: "c", failedJob: "build" });
    await run(s, { status: "failed", ref: "d" });
    // not a failure now: whatever the row still holds is not shown
    await run(s, { status: "success", ref: "e", failureReason: "script_failure", failedJob: "x" });
    mountPage(s.client);
    const t = await table();
    const why = (branch: string) => cells(rowOf(t, branch))[2];
    expect(why("a")).toBe("Script failure in job test");
    expect(why("b")).toBe("Stuck or timeout failure");
    expect(why("c")).toBe("Job build");
    expect(why("d")).toBe("GitLab gave no reason");
    expect(why("e")).toBe("");
  });

  test("links to the pipeline in GitLab, and only when its address is a web address", async () => {
    const s = await sceneOn(backend);
    await run(s, {
      status: "success",
      ref: "good",
      webUrl: "https://gitlab.example/p/-/pipelines/7",
    });
    await run(s, { status: "success", ref: "evil", webUrl: "javascript:alert(1)" });
    mountPage(s.client);
    const t = await table();
    const link = within(rowOf(t, "good")).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://gitlab.example/p/-/pipelines/7");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(within(rowOf(t, "evil")).queryByRole("link")).toBeNull();
  });

  test("only the most recent branches are shown, and it says so", async () => {
    const s = await sceneOn(backend);
    for (let i = 0; i <= 50; i++)
      await run(s, { status: "success", ref: `r${String(i).padStart(2, "0")}` });
    mountPage(s.client);
    const t = await table();
    expect(within(t).getAllByRole("rowheader")).toHaveLength(50);
    expect(within(t).queryByRole("rowheader", { name: "r00" })).toBeNull();
    expect(
      screen.getByText("At most 50 branches are shown, the ones with the newest pipelines."),
    ).toBeDefined();
  });

  test("when it cannot load, the error says so and can be tried again", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    let broken = true;
    mountPage(
      via(s, (request, path) =>
        broken && request.method === "GET" && path.endsWith("/latest")
          ? down("pipelines are down")
          : undefined,
      ),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("pipelines are down");
    broken = false;
    await userEvent.setup().click(await screen.findByRole("button", { name: "Try again" }));
    await table();
  });
});

describe("staying current", () => {
  test("looks again while a pipeline is going, and stops once none is", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "running", ref: "main", gitlabPipelineId: 5001 });
    let looks = 0;
    mountPage(
      via(s, (request, path) => {
        if (request.method === "GET" && path.endsWith("/latest")) looks++;
        return undefined;
      }),
      100,
    );
    const t = await table();
    expect(within(t).getByText("Running")).toBeDefined();
    await run(s, {
      status: "success",
      ref: "main",
      gitlabPipelineId: 5001,
      observedAt: new Date(Date.now() + 60_000),
    });
    await within(t).findByText("Passed", undefined, { timeout: 3000 });
    expect(looks).toBeGreaterThan(1);
    // nothing is going now, so nothing asks again
    const settled = looks;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(looks).toBe(settled);
  });

  test("a look that fails keeps the runs on the screen, and clears when it works again", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "running", ref: "main" });
    let calls = 0;
    let broken = false;
    mountPage(
      via(s, (request, path) => {
        if (request.method !== "GET" || !path.endsWith("/latest")) return undefined;
        calls++;
        return broken && calls > 1 ? down("GitLab is not answering") : undefined;
      }),
      100,
    );
    const t = await table();
    broken = true;
    await waitFor(() => expect(alertText()).toBe("Could not look again: GitLab is not answering"), {
      timeout: 5000,
    });
    expect(within(t).getByText("Running")).toBeDefined();
    broken = false;
    await waitFor(() => expect(alertText()).toBeUndefined(), { timeout: 5000 });
  });
});

describe("retrying", () => {
  test("is offered for a failed or canceled pipeline and for no other", async () => {
    const s = await sceneOn(backend);
    const all = ["success", "failed", "running", "pending", "canceled", "skipped", "manual"];
    for (const status of all) await run(s, { status, ref: `on-${status}` });
    mountPage(s.client);
    const t = await table();
    // the filter chips are buttons too, so look inside the table
    // every row has a Jobs button (FLW-9); Retry is on these two only
    expect(
      within(t)
        .queryAllByRole("button")
        .map((b) => b.textContent)
        .sort(),
    ).toEqual(
      [...all.map((status) => `Jobs on-${status}`), "Retry on-canceled", "Retry on-failed"].sort(),
    );
  });

  test("asks GitLab to run the failed jobs again, once, and shows what it is now", async () => {
    const s = await sceneOn(backend);
    const g = await live(s);
    mountPage(s.client);
    const user = userEvent.setup();
    const t = await table();
    expect(within(t).getByText("Failed")).toBeDefined();
    await user.dblClick(screen.getByRole("button", { name: "Retry main" }));
    expect((await screen.findByRole("status")).textContent).toMatch(
      /^Retried the pipeline on main\. GitLab says it is now \w+\.$/,
    );
    await waitFor(() => expect(within(t).queryByText("Failed") === null).toBe(true), {
      timeout: 5000,
    });
    expect(g.retries()).toBe(1); // a double click is one retry
    expect((await latest(s)).map((r) => r.status)).not.toContain("failed");
    expect(await s.audit("pipeline.retry")).toHaveLength(1);
  });

  test("a refusal is shown in the API's words, and nothing reaches GitLab", async () => {
    const s = await sceneOn(backend, { reporter: true });
    const g = await live(s);
    mountPage(s.client);
    const user = userEvent.setup();
    const t = await table();
    // one word on the page; the whole name stays for assistive technology
    expect(visibleText(screen.getByRole("button", { name: "Retry main" }))).toBe("Retry");
    await user.click(screen.getByRole("button", { name: "Retry main" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /permission|forbidden|not allowed/i,
    );
    expect(within(t).getByText("Failed")).toBeDefined();
    expect(g.retries()).toBe(0);
    expect(await s.audit("pipeline.retry")).toHaveLength(0);
  });

  test("a pipeline whose connection is gone says so", async () => {
    const s = await sceneOn(backend);
    await backend.t.db
      .update(projects)
      .set({ gitlabProjectId: 77 })
      .where(eq(projects.id, s.project.id));
    await run(s, { status: "failed", ref: "main" }); // connectionId: null, as after a deletion
    mountPage(s.client);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Retry main" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "connection that read this pipeline has been deleted",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("while one retry is under way no other can be started", async () => {
    const s = await sceneOn(backend);
    await backend.t.db
      .update(projects)
      .set({ gitlabProjectId: 77 })
      .where(eq(projects.id, s.project.id));
    await run(s, { status: "failed", ref: "main" });
    await run(s, { status: "failed", ref: "dev" });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    mountPage(
      via(s, async (request, path) => {
        if (request.method === "POST" && path.endsWith("/retry")) {
          posts++;
          await held;
        }
        return undefined;
      }),
    );
    const user = userEvent.setup();
    await table();
    const buttons = () =>
      Array.from(document.querySelectorAll<HTMLButtonElement>("table button")).map((b) => [
        b.textContent,
        b.disabled,
      ]);
    // each row also has a Jobs button (FLW-9), which a retry under way does not disable
    expect(buttons()).toEqual([
      ["Jobs dev", false],
      ["Retry dev", false],
      ["Jobs main", false],
      ["Retry main", false],
    ]);
    await user.click(screen.getByRole("button", { name: "Retry dev" }));
    await waitFor(() =>
      expect(buttons()).toEqual([
        ["Jobs dev", false],
        ["Retrying…", true],
        ["Jobs main", false],
        ["Retry main", true],
      ]),
    );
    await user.click(screen.getByRole("button", { name: "Retry main" }));
    expect(posts).toBe(1);
    release();
    await waitFor(() => expect(alertText()).toContain("has been deleted"), { timeout: 5000 });
    expect(buttons()).toEqual([
      ["Jobs dev", false],
      ["Retry dev", false],
      ["Jobs main", false],
      ["Retry main", false],
    ]);
  });

  test("a new retry clears the news of the last one", async () => {
    const s = await sceneOn(backend);
    await live(s);
    // newer than the live one, and with no connection left to retry it with
    await run(s, { status: "failed", ref: "dev", observedAt: new Date(Date.now() + 60_000) });
    mountPage(s.client);
    const user = userEvent.setup();
    await table();
    await user.click(screen.getByRole("button", { name: "Retry main" }));
    await waitFor(() => expect(statusText()).toMatch(/^Retried the pipeline on main/), {
      timeout: 5000,
    });
    await user.click(screen.getByRole("button", { name: "Retry dev" }));
    await waitFor(() => expect(alertText()).toContain("has been deleted"), { timeout: 5000 });
    expect(statusText()).toBeUndefined();
  });

  test("GitLab failing is shown, the run stays failed, and a retry afterwards works", async () => {
    const s = await sceneOn(backend);
    const g = await live(s);
    g.mock.inject({ method: "POST", path: /\/retry$/, status: 500, times: 1 });
    mountPage(s.client);
    const user = userEvent.setup();
    const t = await table();
    await user.click(screen.getByRole("button", { name: "Retry main" }));
    await screen.findByRole("alert");
    expect(within(t).getByText("Failed")).toBeDefined();
    expect((await latest(s)).map((r) => r.status)).toEqual(["failed"]);
    await user.click(screen.getByRole("button", { name: "Retry main" }));
    await screen.findByRole("status");
    expect(screen.queryByRole("alert")).toBeNull(); // the old complaint is gone
    await waitFor(() => expect(within(t).queryByText("Failed") === null).toBe(true), {
      timeout: 5000,
    });
  });
});

describe("the jobs of a pipeline", () => {
  const STAGES =
    "build:\n  stage: build\n  script:\n    - make\nunit:\n  stage: test\n  script:\n    - make test\nlint:\n  stage: test\n  script:\n    - make lint\n";
  const jobsGets = (mock: { requests: { method: string; path: string }[] }) =>
    mock.requests.filter((r) => r.method === "GET" && /\/jobs$/.test(r.path)).length;
  /** The jobs request, counted and answered with `body` (or by the API when there is none). */
  const jobsVia = (s: Scene, answer: () => Response | undefined, count: { n: number }) =>
    via(s, (request, path) => {
      if (request.method !== "GET" || !path.endsWith("/jobs")) return undefined;
      count.n++;
      return answer();
    });
  const open = async (branch: string) => {
    await userEvent.setup().click(await screen.findByRole("button", { name: `Jobs ${branch}` }));
  };
  const job = (over: Record<string, unknown>) => ({
    id: 1,
    name: "build",
    stage: "build",
    status: "success",
    allowFailure: false,
    failureReason: null,
    duration: 12,
    startedAt: "2026-10-20T10:00:00.000Z",
    finishedAt: "2026-10-20T10:00:12.000Z",
    webUrl: "https://gitlab.example/p/-/jobs/1",
    ...over,
  });

  test("is a button on every row that says whether it is open, and nothing is read until it is", async () => {
    const s = await sceneOn(backend);
    const g = await live(s, STAGES);
    mountPage(s.client);
    await table();
    const button = screen.getByRole("button", { name: "Jobs main" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-controls")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(jobsGets(g.mock)).toBe(0);
    await userEvent.setup().click(button);
    await screen.findByText("build", { selector: ".jobs-list code" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const panel = document.getElementById(button.getAttribute("aria-controls") ?? "");
    expect(panel?.textContent).toContain("unit");
    expect(jobsGets(g.mock)).toBe(1);
  });

  test("lists the jobs under their stage, each with its status in words and its time", async () => {
    const s = await sceneOn(backend);
    const g = await live(s, STAGES);
    g.mock.finishPipeline(g.pipelineId, "failed", "script_failure", ["build"]);
    g.mock.addJobFields(g.pipelineId, "build", { duration: 72 });
    g.mock.addJobFields(g.pipelineId, "unit", { duration: 5 });
    g.mock.addJobFields(g.pipelineId, "lint", { duration: 3725 });
    mountPage(s.client);
    await open("main");
    await screen.findByText("lint", { selector: ".jobs-list code" });
    const stages = [...document.querySelectorAll(".jobs-stage")].map((h) => h.textContent);
    expect(stages).toEqual(["build", "test"]);
    const items = [...document.querySelectorAll(".jobs-list li")].map((li) => li.textContent);
    expect(items).toEqual([
      expect.stringMatching(/^Passedbuild1m 12s/),
      expect.stringMatching(/^Failedunit5sScript failure/),
      expect.stringMatching(/^Failedlint1h 2mScript failure/),
    ]);
  });

  test("draws the jobs as nodes: a list for each stage, with lines from each stage to the next", async () => {
    const s = await sceneOn(backend);
    await live(s, STAGES);
    mountPage(s.client);
    await open("main");
    await screen.findByText("lint", { selector: ".jobs-list code" });
    const stages = [...document.querySelectorAll(".job-stage")];
    expect(
      stages.map((st) => [
        st.querySelector("h3")?.textContent,
        [...st.querySelectorAll("ul.jobs-list > li code")].map((c) => c.textContent),
      ]),
    ).toEqual([
      ["build", ["build"]],
      ["test", ["unit", "lint"]],
    ]);
    // one line into the junction after the first stage, two out of it into the second's jobs
    expect(document.querySelectorAll(".job-flow path.job-flow-edge")).toHaveLength(3);
    expect(document.querySelector(".job-flow svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("stages follow the order the jobs were made in, however GitLab lists them", async () => {
    const s = await sceneOn(backend);
    const g = await live(s, STAGES);
    g.mock.listJobsNewestFirst(true);
    try {
      mountPage(s.client);
      await open("main");
      await screen.findByText("lint", { selector: ".jobs-list code" });
      expect([...document.querySelectorAll(".jobs-stage")].map((h) => h.textContent)).toEqual([
        "build",
        "test",
      ]);
    } finally {
      g.mock.listJobsNewestFirst(false);
    }
  });

  test("a failure GitLab words as a code is read as words; a job allowed to fail is not shown as a failure", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "failed", ref: "main" });
    const count = { n: 0 };
    mountPage(
      jobsVia(
        s,
        () =>
          Response.json({
            jobs: [
              job({
                id: 1,
                name: "deploy",
                status: "failed",
                failureReason: "runner_system_failure",
              }),
              job({
                id: 2,
                name: "flaky",
                status: "failed",
                allowFailure: true,
                failureReason: "script_failure",
              }),
            ],
            truncated: false,
          }),
        count,
      ),
    );
    await open("main");
    await screen.findByText("deploy", { selector: ".jobs-list code" });
    const [deploy, flaky] = [...document.querySelectorAll(".jobs-list li")].map(
      (li) => li.textContent,
    );
    expect(deploy).toContain("Failed");
    expect(deploy).toContain("Runner system failure");
    expect(flaky).toContain("Failed, allowed");
  });

  test("a job links to GitLab only when its address is a web address", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    mountPage(
      jobsVia(
        s,
        () =>
          Response.json({
            jobs: [
              job({ id: 1, name: "good" }),
              job({ id: 2, name: "evil", webUrl: "javascript:alert(1)" }),
            ],
            truncated: false,
          }),
        { n: 0 },
      ),
    );
    await open("main");
    await screen.findByText("evil", { selector: ".jobs-list code" });
    const link = screen.getByRole("link", { name: "Open job good" });
    expect(link.getAttribute("href")).toBe("https://gitlab.example/p/-/jobs/1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(screen.queryByRole("link", { name: "Open job evil" })).toBeNull();
  });

  test("says when GitLab has more jobs than are shown", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    mountPage(jobsVia(s, () => Response.json({ jobs: [job({})], truncated: true }), { n: 0 }));
    await open("main");
    await screen.findByText("Showing 1 job. GitLab has more for this pipeline.");
  });

  test("a pipeline with no jobs says so", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "created", ref: "main" });
    mountPage(jobsVia(s, () => Response.json({ jobs: [], truncated: false }), { n: 0 }));
    await open("main");
    await screen.findByText("GitLab lists no jobs for this pipeline.");
  });

  test("a running pipeline's jobs are looked at again, and closing stops it", async () => {
    const s = await sceneOn(backend);
    const g = await live(s, STAGES);
    g.mock.setJobStatus(g.pipelineId, "build", "running");
    await run(s, {
      status: "running",
      ref: "main",
      gitlabPipelineId: g.pipelineId,
      connectionId: g.connectionId,
    });
    mountPage(s.client, 100);
    await open("main");
    await screen.findByText("build", { selector: ".jobs-list code" });
    await waitFor(() => expect(jobsGets(g.mock)).toBeGreaterThan(2), { timeout: 3000 });
    // closing stops the looking
    await open("main");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const closed = jobsGets(g.mock);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(jobsGets(g.mock)).toBe(closed);
    expect(document.querySelector(".jobs-list")).toBeNull();
  });

  test("a pipeline that ends while its jobs are open shows how its jobs ended, then stops looking", async () => {
    const s = await sceneOn(backend);
    const g = await live(s, STAGES);
    g.mock.setJobStatus(g.pipelineId, "build", "running");
    await run(s, {
      status: "running",
      ref: "main",
      gitlabPipelineId: g.pipelineId,
      connectionId: g.connectionId,
    });
    mountPage(s.client, 100);
    await open("main");
    await screen.findByText("Running", { selector: ".jobs-list .st" });
    g.mock.finishPipeline(g.pipelineId, "success");
    await run(s, {
      status: "success",
      ref: "main",
      gitlabPipelineId: g.pipelineId,
      connectionId: g.connectionId,
      observedAt: new Date(Date.now() + 60_000),
    });
    await waitFor(
      () =>
        expect([...document.querySelectorAll(".jobs-list .st")].map((e) => e.textContent)).toEqual([
          "Passed",
          "Passed",
          "Passed",
        ]),
      { timeout: 5000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = jobsGets(g.mock);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(jobsGets(g.mock)).toBe(settled);
  });

  test("a failure shows the error with a way to try again, and it works afterwards", async () => {
    const s = await sceneOn(backend);
    const g = await live(s, STAGES);
    let broken = true;
    mountPage(jobsVia(s, () => (broken ? down("jobs are down") : undefined), { n: 0 }));
    await open("main");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("jobs are down");
    broken = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByText("unit", { selector: ".jobs-list code" });
    expect(jobsGets(g.mock)).toBe(1);
  });

  test("a look that fails keeps the jobs on the screen and says so", async () => {
    const s = await sceneOn(backend);
    const g = await live(s, STAGES);
    g.mock.setJobStatus(g.pipelineId, "build", "running");
    await run(s, {
      status: "running",
      ref: "main",
      gitlabPipelineId: g.pipelineId,
      connectionId: g.connectionId,
    });
    const count = { n: 0 };
    let broken = false;
    mountPage(
      jobsVia(
        s,
        () => (broken && count.n > 1 ? down("GitLab is not answering") : undefined),
        count,
      ),
      100,
    );
    await open("main");
    await screen.findByText("unit", { selector: ".jobs-list code" });
    broken = true;
    await waitFor(() => expect(alertText()).toBe("Could not look again: GitLab is not answering"), {
      timeout: 5000,
    });
    expect(screen.getByText("unit", { selector: ".jobs-list code" })).toBeDefined();
  });

  test("a pipeline whose connection is gone says so in the panel", async () => {
    const s = await sceneOn(backend);
    await backend.t.db
      .update(projects)
      .set({ gitlabProjectId: 77 })
      .where(eq(projects.id, s.project.id));
    await run(s, { status: "failed", ref: "main" }); // connectionId: null, as after a deletion
    mountPage(s.client);
    await open("main");
    expect((await screen.findByRole("alert")).textContent).toContain(
      "connection that read this pipeline has been deleted",
    );
  });

  test("each row opens its own jobs", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "one" });
    await run(s, { status: "success", ref: "two" });
    const count = { n: 0 };
    mountPage(
      jobsVia(
        s,
        () => Response.json({ jobs: [job({ name: "only-job" })], truncated: false }),
        count,
      ),
    );
    await open("one");
    await screen.findByText("only-job", { selector: ".jobs-list code" });
    expect(screen.getByRole("button", { name: "Jobs two" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(count.n).toBe(1);
  });

  // NOD-7: a trigger is a node, and the child pipeline it started is a lane
  const trigger = (over: Record<string, unknown> = {}) => ({
    id: 50,
    name: "launch",
    stage: "deploy",
    status: "success",
    webUrl: "https://gitlab.example/p/-/jobs/50",
    downstream: {
      pipelineId: 9,
      status: "success",
      sameProject: true,
      projectId: null,
      gone: false,
    },
    ...over,
  });
  const answer = (over: Record<string, unknown>) =>
    Response.json({
      jobs: [],
      truncated: false,
      triggers: [],
      triggersTruncated: false,
      children: [],
      ...over,
    });
  const child = (over: Record<string, unknown> = {}) => ({
    pipelineId: 9,
    status: "success",
    truncated: false,
    jobs: [
      job({ id: 10, name: "migrate", stage: "test" }),
      job({ id: 11, name: "smoke", stage: "test" }),
    ],
    ...over,
  });
  const codes = (root: ParentNode) =>
    [...root.querySelectorAll(".jobs-list code")].map((c) => c.textContent);
  const lanes = () => [...document.querySelectorAll<HTMLElement>(".job-flow section")];

  test("a trigger and the child pipeline it started are drawn as a chain: the trigger in its stage, the child's jobs as a lane", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    mountPage(
      jobsVia(
        s,
        () =>
          answer({
            jobs: [
              job({ id: 1, name: "build", stage: "build" }),
              job({ id: 2, name: "ship", stage: "deploy" }),
            ],
            triggers: [trigger()],
            children: [child()],
          }),
        { n: 0 },
      ),
    );
    await open("main");
    await screen.findByText("migrate", { selector: ".jobs-list code" });
    const [lane] = lanes();
    expect(lanes()).toHaveLength(1);
    expect(lane?.querySelector("h3")?.textContent).toBe("Child pipeline #9");
    expect(codes(lane as HTMLElement)).toEqual(["migrate", "smoke"]);
    const own = [...document.querySelectorAll(".job-flow-canvas > .job-stage")];
    expect(own.map((st) => [st.querySelector("h3")?.textContent, codes(st)])).toEqual([
      ["build", ["build"]],
      ["deploy", ["ship", "launch"]],
    ]);
    const trig = document.querySelector(".job-trigger");
    expect(trig?.querySelector(".job-kind")?.textContent).toBe("Triggers");
    // build to deploy (3 lines), the trigger into the lane (1), the lane's junction into its two jobs (2)
    expect(document.querySelectorAll(".job-flow path.job-flow-edge")).toHaveLength(6);
  });

  test("a child pipeline that GitLab's mock holds is drawn from the real answer of the API", async () => {
    const s = await sceneOn(backend);
    const g = await live(s, STAGES);
    g.mock.addDownstream(g.pipelineId, "launch", ["migrate", "smoke"], { stage: "test" });
    mountPage(s.client);
    await open("main");
    await screen.findByText("migrate", { selector: ".jobs-list code" });
    expect(lanes().map((l) => codes(l))).toEqual([["migrate", "smoke"]]);
    expect(lanes()[0]?.querySelector("h3")?.textContent).toBe(
      `Child pipeline #${g.pipelineId + 1}`,
    );
    expect(document.querySelectorAll(".job-trigger")).toHaveLength(1);
  });

  test("a trigger into another project shows that it is, and its state, with no link and no lane", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "running", ref: "main" });
    mountPage(
      jobsVia(
        s,
        () =>
          answer({
            triggers: [
              trigger({
                status: "running",
                webUrl: "",
                downstream: {
                  pipelineId: 77,
                  status: "running",
                  sameProject: false,
                  projectId: 123,
                  gone: false,
                },
              }),
            ],
          }),
        { n: 0 },
      ),
    );
    await open("main");
    const node = await screen.findByText("Pipeline in another project: running");
    expect(node.closest("li")?.querySelector("a")).toBeNull();
    expect(lanes()).toHaveLength(0);
  });

  // NOD-9: the node says what the other project's pipeline is doing and that it is another project's, and nothing else: the
  // numbers the answer carries are for matching it to a project the viewer can see (NOD-11), not for showing
  test("a trigger into another project says that pipeline's state and that it is another project's, and nothing else", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "failed", ref: "main" });
    mountPage(
      jobsVia(
        s,
        () =>
          answer({
            triggers: [
              trigger({
                name: "launch",
                status: "success",
                webUrl: "",
                downstream: {
                  pipelineId: 7777,
                  status: "failed",
                  sameProject: false,
                  projectId: 4242,
                  gone: false,
                },
              }),
            ],
          }),
        { n: 0 },
      ),
    );
    await open("main");
    await screen.findByText("Pipeline in another project: failed");
    const node = document.querySelector<HTMLElement>(".job-trigger");
    expect(node?.querySelector(".job-note")?.textContent).toBe(
      "Pipeline in another project: failed",
    );
    // the trigger's own state is the node's, the other pipeline's is in the note
    expect(node?.querySelector(".st")?.textContent).toContain("Passed");
    expect(node?.textContent).not.toMatch(/7777|4242/);
    expect(node?.querySelector("a")).toBeNull();
    expect(node?.querySelector(".job-kind")?.textContent).toBe("Triggers");
  });

  // NOD-11: a node for another project's pipeline is expanded only into a project this viewer's own list holds
  describe("a pipeline of another project", () => {
    const THEIRS = 4242;
    const ahead = (over: Record<string, unknown> = {}) =>
      answer({
        triggers: [
          trigger({
            name: "launch",
            webUrl: "",
            downstream: {
              pipelineId: 7777,
              status: "running",
              sameProject: false,
              projectId: THEIRS,
              gone: false,
              ...over,
            },
          }),
        ],
      });
    const their = () =>
      answer({
        jobs: [
          job({ id: 70, name: "ship-api", stage: "deploy" }),
          job({ id: 71, name: "smoke-api", stage: "verify" }),
        ],
      });
    /** `acme/api` of the scene's organization, as GitLab's project `number`, with a run of pipeline 7777 unless `recorded` is false. */
    const api = async (
      s: Scene,
      o: { number?: number; recorded?: boolean; webUrl?: string } = {},
    ) => {
      const project = await createProject(backend.t.db, {
        organizationId: s.org.id,
        name: "acme/api",
        gitlabProjectId: o.number ?? THEIRS,
      });
      if (o.recorded !== false) {
        await run(s, {
          status: "running",
          ref: "main",
          projectId: project.id,
          gitlabPipelineId: 7777,
          ...(o.webUrl ? { webUrl: o.webUrl } : {}),
        });
      }
      return project;
    };
    /**
     * The jobs of each project answered from here by the project's id, everything asked kept in `seen`, and
     * the project list cut to the scene's own project when `onlyMine` (a viewer who cannot see the other).
     */
    const across = (
      s: Scene,
      o: { mine?: () => Response; theirs?: () => Response; onlyMine?: boolean } = {},
    ) => {
      const seen: string[] = [];
      const client = clientVia(backend.api, s.cookie, async (request, send) => {
        const path = pathOf(request);
        seen.push(`${request.method} ${path}${new URL(request.url).search}`);
        if (request.method === "GET" && path.endsWith("/jobs")) {
          return path.includes(`/projects/${s.project.id}/`)
            ? (o.mine ?? ahead)()
            : (o.theirs ?? their)();
        }
        if (
          o.onlyMine &&
          request.method === "GET" &&
          path === `/organizations/${s.org.id}/projects`
        ) {
          const body = await (await send()).json();
          return Response.json({
            ...body,
            items: body.items.filter((p: { id: string }) => p.id === s.project.id),
          });
        }
        return send();
      });
      const asked = (project: { id: string }) =>
        seen.filter((r) => r.includes(`/projects/${project.id}/`));
      return { client, seen, asked };
    };
    const note = () =>
      [...document.querySelectorAll(".job-trigger .job-note")].map((n) => n.textContent);

    test("in a project the viewer can see it is drawn as the next lane, headed with that project's name", async () => {
      const s = await sceneOn(backend);
      await run(s, { status: "success", ref: "main" });
      const other = await api(s);
      const c = across(s);
      mountPage(c.client);
      await open("main");
      await screen.findByText("ship-api", { selector: ".jobs-list code" });
      expect(lanes()).toHaveLength(1);
      const heading = lanes()[0]?.querySelector("h3");
      expect(heading?.textContent).toBe("acme/api #7777");
      // a long name is cut by the box, so it is whole in the title
      expect(heading?.getAttribute("title")).toBe("acme/api #7777");
      expect(codes(lanes()[0] as HTMLElement)).toEqual(["ship-api", "smoke-api"]);
      // the node still says it is another project's; nothing says why jobs are missing, for none are
      expect(note()).toEqual(["Pipeline in another project: running"]);
      // that project's run list was asked for this pipeline, and its jobs read for the run found
      expect(c.asked(other).some((r) => r.includes("pipelineId=7777"))).toBe(true);
      expect(c.asked(other).some((r) => /\/pipeline-runs\/[^/]+\/jobs$/.test(r))).toBe(true);
    });

    test("in a project the viewer cannot see nothing is asked of it, and the node says it is not set up here", async () => {
      const s = await sceneOn(backend);
      await run(s, { status: "success", ref: "main" });
      // acme/api exists and is GitLab's project 4242, but the viewer's own list does not hold it
      const other = await api(s);
      const c = across(s, { onlyMine: true });
      mountPage(c.client);
      await open("main");
      await screen.findByText("Not set up here");
      expect(lanes()).toHaveLength(0);
      expect(note()).toEqual(["Pipeline in another project: running", "Not set up here"]);
      expect(c.asked(other)).toEqual([]);
    });

    test("in no project of the organization nothing else is asked either: only the number is matched, never a name", async () => {
      const s = await sceneOn(backend);
      await run(s, { status: "success", ref: "main" });
      const other = await api(s, { number: 999 });
      const c = across(s);
      mountPage(c.client);
      await open("main");
      await screen.findByText("Not set up here");
      expect(lanes()).toHaveLength(0);
      expect(c.asked(other)).toEqual([]);
    });

    test("a pipeline with no project number is matched to no project, not to one that has no number either", async () => {
      const s = await sceneOn(backend);
      await run(s, { status: "success", ref: "main" });
      // a project made by hand has no GitLab number, and neither does what GitLab sent
      const byHand = await createProject(backend.t.db, {
        organizationId: s.org.id,
        name: "acme/by-hand",
        gitlabProjectId: null,
      });
      const c = across(s, { mine: () => ahead({ projectId: null }) });
      mountPage(c.client);
      await open("main");
      await screen.findByText("Not set up here");
      expect(lanes()).toHaveLength(0);
      expect(c.asked(byHand)).toEqual([]);
      expect(c.seen.some((r) => r.includes("pipelineId="))).toBe(false);
    });

    test("in a project that has no run of that pipeline yet it says so, and asks for no jobs", async () => {
      const s = await sceneOn(backend);
      await run(s, { status: "success", ref: "main" });
      const other = await api(s, { recorded: false });
      const c = across(s);
      mountPage(c.client);
      await open("main");
      await screen.findByText("Not recorded yet");
      expect(lanes()).toHaveLength(0);
      expect(note()).toEqual(["Pipeline in another project: running", "Not recorded yet"]);
      expect(c.asked(other).some((r) => r.includes("pipelineId=7777"))).toBe(true);
      expect(c.asked(other).some((r) => r.endsWith("/jobs"))).toBe(false);
    });

    test("a run that is from another GitLab's address is not the pipeline: GitLab's numbers are only its own", async () => {
      const s = await sceneOn(backend);
      await run(s, { status: "success", ref: "main" });
      const other = await api(s, { webUrl: "https://elsewhere.example/acme/api/-/pipelines/7777" });
      const c = across(s);
      mountPage(c.client);
      await open("main");
      await screen.findByText("Not recorded yet");
      expect(lanes()).toHaveLength(0);
      expect(c.asked(other).some((r) => r.endsWith("/jobs"))).toBe(false);
    });

    test("a project whose jobs cannot be read leaves the pipeline's own jobs drawn and says so in a word", async () => {
      const s = await sceneOn(backend);
      await run(s, { status: "success", ref: "main" });
      await api(s);
      const c = across(s, {
        mine: () =>
          answer({
            jobs: [job({ id: 1, name: "build", stage: "build" })],
            triggers: [
              trigger({
                webUrl: "",
                downstream: {
                  pipelineId: 7777,
                  status: "running",
                  sameProject: false,
                  projectId: THEIRS,
                  gone: false,
                },
              }),
            ],
          }),
        theirs: () => down("secret detail of the other project"),
      });
      mountPage(c.client);
      await open("main");
      await screen.findByText("Could not read its jobs");
      expect(lanes()).toHaveLength(0);
      expect(codes(document.body)).toContain("build");
      expect(document.body.textContent).not.toContain("secret detail");
    });

    test("looks again while the pipeline it started is going, in both projects, and stops once it is not", async () => {
      const s = await sceneOn(backend);
      await run(s, { status: "success", ref: "main" });
      const other = await api(s);
      const state = { status: "running" };
      const c = across(s, { mine: () => ahead({ status: state.status }) });
      const reads = (mine: boolean) =>
        c.seen.filter(
          (r) => r.endsWith("/jobs") && r.includes(`/projects/${s.project.id}/`) === mine,
        ).length;
      mountPage(c.client, 100);
      await open("main");
      await screen.findByText("ship-api", { selector: ".jobs-list code" });
      // the run of the viewer's own project has ended; what keeps both looking is the pipeline it started
      await waitFor(() => expect(Math.min(reads(true), reads(false))).toBeGreaterThan(2), {
        timeout: 3000,
      });
      state.status = "success";
      await screen.findByText("Pipeline in another project: passed");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const settled = [reads(true), reads(false)];
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect([reads(true), reads(false)]).toEqual(settled);
      expect(c.asked(other).length).toBeGreaterThan(0);
    });
  });

  test("a pipeline of one trigger shows it, and does not say GitLab lists no jobs", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    mountPage(jobsVia(s, () => answer({ triggers: [trigger({ downstream: null })] }), { n: 0 }));
    await open("main");
    await screen.findByText("launch", { selector: ".jobs-list code" });
    expect(screen.queryByText("GitLab lists no jobs for this pipeline.")).toBeNull();
    expect(document.querySelector(".job-note")).toBeNull();
  });

  test("a child that is gone says so, and one that was not read says it is not shown", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    const down = { pipelineId: 10, status: "running", sameProject: true, projectId: null };
    mountPage(
      jobsVia(
        s,
        () =>
          answer({
            triggers: [
              trigger({ id: 50, name: "old", downstream: { ...down, gone: true } }),
              trigger({ id: 51, name: "late", downstream: { ...down, gone: false } }),
            ],
          }),
        { n: 0 },
      ),
    );
    await open("main");
    await screen.findByText("Pipeline no longer on GitLab");
    await screen.findByText("Child pipeline not shown");
    expect(lanes()).toHaveLength(0);
  });

  test("a state this version does not know still draws, in its own words", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    mountPage(
      jobsVia(
        s,
        () =>
          answer({
            triggers: [trigger({ status: "waiting_for_callback" })],
            children: [
              child({
                jobs: [job({ id: 10, name: "migrate", stage: "test", status: "invented_later" })],
              }),
            ],
          }),
        { n: 0 },
      ),
    );
    await open("main");
    await screen.findByText("waiting for callback");
    await screen.findByText("invented later");
  });

  test("says when GitLab has more triggers than are shown, or more jobs in a child", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "success", ref: "main" });
    mountPage(
      jobsVia(
        s,
        () =>
          answer({
            triggers: [trigger()],
            triggersTruncated: true,
            children: [child({ truncated: true })],
          }),
        { n: 0 },
      ),
    );
    await open("main");
    await screen.findByText("Showing 1 trigger. GitLab has more for this pipeline.");
    await screen.findByText("Child pipeline #9: showing 2 jobs. GitLab has more.");
  });
});

describe("the filter", () => {
  const shownBranches = () =>
    Array.from(document.querySelectorAll("tbody th"))
      .map((th) => th.textContent)
      .sort();
  const chip = (name: string) =>
    within(screen.getByRole("group", { name: "Filter by result" })).getByRole("button", { name });

  test("counts each kind of result, and a chip narrows the table to it", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "failed", ref: "f1" });
    await run(s, { status: "failed", ref: "f2" });
    await run(s, { status: "running", ref: "r1" });
    await run(s, { status: "success", ref: "p1" });
    await run(s, { status: "canceled", ref: "o1" });
    mountPage(s.client);
    await table();
    for (const name of ["All 5", "Failed 2", "Running 1", "Passed 1", "Other 1"])
      expect(chip(name)).toBeTruthy();
    expect(chip("All 5").getAttribute("aria-pressed")).toBe("true");
    expect(shownBranches()).toEqual(["f1", "f2", "o1", "p1", "r1"]);

    const user = userEvent.setup();
    await user.click(chip("Failed 2"));
    expect(shownBranches()).toEqual(["f1", "f2"]);
    expect(chip("Failed 2").getAttribute("aria-pressed")).toBe("true");
    expect(chip("All 5").getAttribute("aria-pressed")).toBe("false");
    await user.click(chip("Other 1"));
    expect(shownBranches()).toEqual(["o1"]);
    await user.click(chip("All 5"));
    expect(shownBranches()).toHaveLength(5);
  });

  test("a kind with nothing in it says so, and All brings the table back", async () => {
    const s = await sceneOn(backend);
    await run(s, { status: "failed", ref: "only" });
    mountPage(s.client);
    await table();
    const user = userEvent.setup();
    await user.click(chip("Passed 0"));
    expect(screen.getByText("No branch has a pipeline in that state.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    await user.click(chip("All 1"));
    expect(shownBranches()).toEqual(["only"]);
  });
});

// DNS-16: the plans of the project, with the DNS zones labelled and a denied plan's reasons
describe("the plans", () => {
  const plans = () => screen.findByRole("table", { name: "Plan runs" });
  const plan = (
    s: Scene,
    over: { ref: string; stacks: string[]; mergeRequestIid?: number; kind?: "plan" | "drift" } & {
      dnsPrune?: Record<string, boolean>;
    },
  ) =>
    createRun(backend.t.db, {
      organizationId: s.org.id,
      projectId: s.project.id,
      sha: "c0ffee1234567890".padEnd(40, "0"),
      mergeRequestIid: null,
      kind: "plan",
      uncosted: Object.keys(over.dnsPrune ?? {}),
      ...over,
    });
  const stackOf = (t: HTMLElement, name: string) => {
    const li = within(t).getByText(name, { selector: "code" }).closest("li");
    if (!li) throw new Error(`no stack ${name}`);
    return li;
  };

  // FLW-3: the order the stacks of a plan go in, as registered
  describe("the order", () => {
    const registered = (name: string, dependsOn: string[] = []): NewStack => ({
      name,
      path: name,
      tool: "tofu",
      version: "1.9.8",
      tags: [],
      dependsOn,
      watch: [],
      applyOn: "command",
      backend: "http",
    });
    const register = (s: Scene, stacks: NewStack[]) =>
      syncStacks(backend.t.db, s.org.id, s.project.id, stacks, { prune: false });
    const boxes = () => document.querySelectorAll(".run-graph-box");
    const edges = () => document.querySelectorAll("path.run-graph-edge");
    const showOrder = () => screen.findByText("Show order");

    test("a plan whose stacks wait for each other offers the order, closed, and draws it when opened", async () => {
      const s = await sceneOn(backend);
      await register(s, [registered("vpc"), registered("db", ["vpc"]), registered("app", ["db"])]);
      await plan(s, { ref: "feature/net", stacks: ["app", "db", "vpc"] });
      mountPage(s.client, 100_000);
      const t = await plans();
      const summary = await showOrder();
      expect(boxes()).toHaveLength(0);
      await userEvent.setup().click(summary);
      await waitFor(() => expect(boxes()).toHaveLength(3));
      expect(edges()).toHaveLength(2);
      expect(within(t).getByText("As registered on the default branch.")).toBeTruthy();
      expect(within(t).getByText("app waits for db")).toBeTruthy();
    });

    test("a plan whose stacks wait for nothing offers no order", async () => {
      const s = await sceneOn(backend);
      await register(s, [registered("net"), registered("app")]);
      await plan(s, { ref: "feature/net", stacks: ["net", "app"] });
      mountPage(s.client, 100_000);
      await plans();
      expect(screen.queryByText("Show order")).toBeNull();
    });

    test("a plan of more than 60 stacks says the order is not drawn, and draws none", async () => {
      const s = await sceneOn(backend);
      const names = Array.from({ length: 61 }, (_, i) => `s${String(i).padStart(2, "0")}`);
      await register(s, [
        registered("s00"),
        registered("s01", ["s00"]),
        ...names.slice(2).map((n) => registered(n)),
      ]);
      await plan(s, { ref: "feature/big", stacks: names });
      mountPage(s.client, 100_000);
      await plans();
      await screen.findByText(/order is not drawn for a plan of more than 60 stacks/);
      expect(screen.queryByText("Show order")).toBeNull();
      expect(boxes()).toHaveLength(0);
    });
  });

  test("says so when no plan has been made, and offers no table", async () => {
    const s = await sceneOn(backend);
    mountPage(s.client);
    await screen.findByText(/No plan has been made for this project yet/);
    expect(screen.queryByRole("table", { name: "Plan runs" })).toBeNull();
  });

  test("lists each plan with its branch, its merge request or its kind, and where each stack is", async () => {
    const s = await sceneOn(backend);
    const r = await plan(s, { ref: "feature/net", mergeRequestIid: 12, stacks: ["net", "app"] });
    await moveRunStack(backend.t.db, s.org.id, s.project.id, r.id, "net", "queued", "planning");
    await moveRunStack(backend.t.db, s.org.id, s.project.id, r.id, "net", "planning", "planned");
    await moveRunStack(backend.t.db, s.org.id, s.project.id, r.id, "app", "queued", "planning");
    await moveRunStack(
      backend.t.db,
      s.org.id,
      s.project.id,
      r.id,
      "app",
      "planning",
      "failed",
      "the plan job failed",
    );
    await plan(s, { ref: "main", kind: "drift", stacks: ["net"] });
    mountPage(s.client, 100_000);
    const t = await plans();
    const mr = within(t)
      .getByRole("rowheader", { name: /feature\/net/ })
      .closest("tr") as HTMLElement;
    expect(mr.textContent).toContain("MR !12");
    expect(stackOf(mr, "net").textContent).toContain("Planned");
    expect(stackOf(mr, "app").textContent).toContain("Failed");
    expect(stackOf(mr, "app").textContent).toContain("the plan job failed");
    const drift = within(t).getByRole("rowheader", { name: /main/ }).closest("tr") as HTMLElement;
    expect(drift.textContent).toContain("Drift check");
    expect(drift.textContent).not.toContain("MR");
  });

  test("a DNS zone is labelled and shows its lint; a stack that is not a zone is neither", async () => {
    const s = await sceneOn(backend);
    const r = await plan(s, {
      ref: "feature/dns",
      stacks: ["zone", "net"],
      dnsPrune: { zone: false },
    });
    await storePlanSummary(backend.t.db, s.org.id, s.project.id, r.id, "zone", {
      add: 1,
      change: 0,
      destroy: 0,
      resources: [{ address: "example.com/_canary-secret/TXT", actions: ["create"] }],
      lint: { errors: 1, warnings: 2 },
    });
    mountPage(s.client, 100_000);
    const t = await plans();
    expect(stackOf(t, "zone").textContent).toContain("DNS zone");
    expect(stackOf(t, "zone").textContent).toContain("1 error, 2 warnings");
    expect(stackOf(t, "net").textContent).not.toContain("DNS zone");
    expect(stackOf(t, "net").textContent).not.toContain("error");
    // the plan holds a record's name, and the page never had it
    expect(document.body.textContent).not.toContain("canary");
  });

  test("a zone linted clean says so; one never linted says nothing of it", async () => {
    const s = await sceneOn(backend);
    const r = await plan(s, {
      ref: "feature/dns",
      stacks: ["clean", "bare"],
      dnsPrune: { clean: false, bare: false },
    });
    const sum = { add: 0, change: 0, destroy: 0, resources: [] };
    await storePlanSummary(backend.t.db, s.org.id, s.project.id, r.id, "clean", {
      ...sum,
      lint: { errors: 0, warnings: 0 },
    });
    await storePlanSummary(backend.t.db, s.org.id, s.project.id, r.id, "bare", sum);
    mountPage(s.client, 100_000);
    const t = await plans();
    expect(stackOf(t, "clean").textContent).toContain("Lint found nothing");
    expect(stackOf(t, "bare").textContent).not.toMatch(/lint/i);
  });

  test("a denied plan shows each reason, a warned one its warnings, and one not judged neither", async () => {
    const s = await sceneOn(backend);
    const r = await plan(s, {
      ref: "feature/dns",
      stacks: ["denied", "warned", "waiting"],
      dnsPrune: { denied: false },
    });
    const say = (stack: string, denied: string[], warned: string[]) =>
      storePolicyVerdict(backend.t.db, s.org.id, s.project.id, r.id, stack, {
        evaluated: true,
        denied,
        warned,
      });
    await say(
      "denied",
      ["dns-delete-without-prune:example.com", "dns-zone-unclaimed:example.org"],
      [],
    );
    await say("warned", [], ["dns-lint-ttl-range:example.com"]);
    mountPage(s.client, 100_000);
    const t = await plans();
    const denied = stackOf(t, "denied");
    expect(denied.textContent).toContain("Denied");
    expect(within(denied).getByText("dns-delete-without-prune:example.com")).toBeDefined();
    expect(within(denied).getByText("dns-zone-unclaimed:example.org")).toBeDefined();
    const warned = stackOf(t, "warned");
    expect(warned.textContent).toContain("Warnings");
    expect(within(warned).getByText("dns-lint-ttl-range:example.com")).toBeDefined();
    expect(warned.textContent).not.toContain("Denied");
    expect(stackOf(t, "waiting").textContent).not.toMatch(/denied|warnings/i);
  });

  test("when the plans cannot load, the error says so and can be tried again", async () => {
    const s = await sceneOn(backend);
    await plan(s, { ref: "feature/net", stacks: ["net"] });
    let broken = true;
    mountPage(
      via(s, (request, path) =>
        broken && request.method === "GET" && path.endsWith("/runs")
          ? down("plans are down")
          : undefined,
      ),
      100_000,
    );
    await waitFor(() => expect(alertText()).toContain("plans are down"));
    broken = false;
    await userEvent.setup().click(await screen.findByRole("button", { name: "Try again" }));
    await plans();
  });

  test("looks again while a stack is going, and stops once none is", async () => {
    const s = await sceneOn(backend);
    const r = await plan(s, { ref: "feature/net", stacks: ["net"] });
    await moveRunStack(backend.t.db, s.org.id, s.project.id, r.id, "net", "queued", "planning");
    let looks = 0;
    mountPage(
      via(s, (request, path) => {
        if (request.method === "GET" && path.endsWith("/runs")) looks++;
        return undefined;
      }),
      100,
    );
    const t = await plans();
    expect(stackOf(t, "net").textContent).toContain("Planning");
    await moveRunStack(backend.t.db, s.org.id, s.project.id, r.id, "net", "planning", "planned");
    await within(t).findByText("Planned", undefined, { timeout: 3000 });
    expect(looks).toBeGreaterThan(1);
    const settled = looks;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(looks).toBe(settled);
  });
});
