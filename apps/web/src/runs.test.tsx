import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type NewPipelineRun, projects, recordPipelineRun } from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eq } from "drizzle-orm";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { OrgProvider, RequireOrg } from "./org";
import { RunsPage } from "./runs";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";
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
async function live(s: Scene) {
  const mock = backend.gitlab(undefined, ["api"]);
  const gl = mock.addProject({
    path: `fx/runs-${++id}`,
    files: { ".gitlab-ci.yml": "test:\n  script:\n    - echo hi\n" },
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
  return { mock, gl, retries };
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
      expect([status, tag.className]).toEqual([status, `tag status-${tone}`]);
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
    await table();
    expect(
      screen
        .queryAllByRole("button")
        .map((b) => b.textContent)
        .sort(),
    ).toEqual(["Retry on-canceled", "Retry on-failed"]);
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
      Array.from(document.querySelectorAll("button")).map((b) => [b.textContent, b.disabled]);
    expect(buttons()).toEqual([
      ["Retry dev", false],
      ["Retry main", false],
    ]);
    await user.click(screen.getByRole("button", { name: "Retry dev" }));
    await waitFor(() =>
      expect(buttons()).toEqual([
        ["Retrying…", true],
        ["Retry main", true],
      ]),
    );
    await user.click(document.querySelectorAll("button")[1] as HTMLElement);
    expect(posts).toBe(1);
    release();
    await waitFor(() => expect(alertText()).toContain("has been deleted"), { timeout: 5000 });
    expect(buttons()).toEqual([
      ["Retry dev", false],
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
