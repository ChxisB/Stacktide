import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  auditEvents,
  environments,
  projects,
  recordDeployment,
  recordPipelineRun,
  savePipelineConfig,
  setEnvironmentProtection,
} from "@orch/db";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { and, eq } from "drizzle-orm";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { OrgProvider, RequireOrg } from "./org";
import { RunsPage } from "./runs";
import { type Backend, clientVia, down, pathOf, startBackend } from "./testing";
import { must, scene as sceneOn } from "./variables.fixture";

// DEP-7: what is deployed where, on the Status page beside the pipelines and the plans.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/status";
});

type Scene = Awaited<ReturnType<typeof sceneOn>>;
let id = 5000;
const SHA = (c: string) => c.repeat(40);

/** A deployment as the worker stores it, for the scene's project. */
const deployed = (
  s: Scene,
  over: { environment: string; status: string; sha: string } & Partial<{
    gitlabDeploymentId: number;
    pipelineId: number | null;
    connectionId: string | null;
    ref: string;
  }>,
) =>
  recordDeployment(backend.t.db, {
    organizationId: s.org.id,
    projectId: s.project.id,
    connectionId: null,
    gitlabDeploymentId: ++id,
    ref: "main",
    jobId: null,
    pipelineId: null,
    finishedAt: new Date(Date.UTC(2026, 9, 1, 10, 30)),
    observedAt: new Date(Date.UTC(2026, 9, 1, 10, 30)),
    ...over,
  });

function mountPage(client: ReturnType<Backend["anonymous"]>) {
  render(
    <Providers client={client} queries={newQueryClient()}>
      <AuthGate>
        <OrgProvider>
          <RequireOrg>{(org) => <RunsPage orgId={org.id} />}</RequireOrg>
        </OrgProvider>
      </AuthGate>
    </Providers>,
  );
}

/** The Deployments card, once it has loaded. */
const card = async () => screen.findByRole("region", { name: "Deployments" });
/** The box of one environment. */
const box = async (name: string) =>
  within(await card())
    .getByRole("heading", { name })
    .closest("li") as HTMLElement;
const words = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the Deployments card", () => {
  test("a box for each environment in sort order, with what is deployed there", async () => {
    const s = await sceneOn(backend, { environments: [] });
    await s.scope.environments.post({ name: "Production", slug: "production", sortOrder: 2 });
    await s.scope.environments.post({ name: "Staging", slug: "staging", sortOrder: 1 });
    await deployed(s, { environment: "staging", status: "success", sha: SHA("a"), ref: "main" });
    await deployed(s, {
      environment: "production",
      status: "success",
      sha: SHA("b"),
      ref: "release",
    });
    mountPage(s.client);
    const c = await card();
    await within(c).findByRole("heading", { name: "Staging" });
    expect(
      within(c)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual(["Staging", "Production"]);
    const staging = words(await box("Staging"));
    expect(staging).toContain("Deployed");
    expect(staging).toContain("aaaaaaaa");
    expect(staging).not.toContain("a".repeat(9)); // the short sha, not the whole
    expect(staging).toContain("main");
    expect(staging).toContain("2026-10-01 10:30 UTC");
    const production = words(await box("Production"));
    expect(production).toContain("bbbbbbbb");
    expect(production).toContain("release");
    // a box shows its last attempt only when it differs from what is deployed
    expect(staging).not.toContain("Last attempt");
  });

  test("a newer failure is shown under what is deployed, and a build in progress too", async () => {
    const s = await sceneOn(backend, { environments: ["staging", "production"] });
    await deployed(s, { environment: "staging", status: "success", sha: SHA("a") });
    await deployed(s, { environment: "staging", status: "failed", sha: SHA("b") });
    await deployed(s, { environment: "production", status: "success", sha: SHA("c") });
    await deployed(s, { environment: "production", status: "running", sha: SHA("d") });
    mountPage(s.client);
    const staging = words(await box("staging"));
    expect(staging).toMatch(/Deployed.*aaaaaaaa/);
    expect(staging).toMatch(/Last attempt.*Failed.*bbbbbbbb/);
    const production = words(await box("production"));
    expect(production).toMatch(/Deployed.*cccccccc/);
    expect(production).toMatch(/Last attempt.*Deploying.*dddddddd/);
  });

  test("an environment that only ever failed, and one with nothing, say so", async () => {
    const s = await sceneOn(backend, { environments: ["qa", "staging"] });
    await deployed(s, { environment: "qa", status: "failed", sha: SHA("e") });
    mountPage(s.client);
    const qa = words(await box("qa"));
    expect(qa).toContain("Nothing has been deployed here yet");
    expect(qa).toMatch(/Last attempt.*Failed.*eeeeeeee/);
    const staging = words(await box("staging"));
    expect(staging).toContain("Nothing has been deployed here yet");
    expect(staging).not.toContain("Last attempt");
  });

  test("a protected environment is marked in words", async () => {
    const s = await sceneOn(backend, { environments: ["production", "staging"] });
    await backend.t.db
      .update(environments)
      .set({ protected: true })
      .where(and(eq(environments.projectId, s.project.id), eq(environments.slug, "production")));
    mountPage(s.client);
    expect(words(await box("production"))).toContain("Protected");
    expect(words(await box("staging"))).not.toContain("Protected");
  });

  test("a status this version does not know still draws, in its own words", async () => {
    const s = await sceneOn(backend, { environments: ["staging"] });
    await deployed(s, { environment: "staging", status: "success", sha: SHA("a") });
    await deployed(s, { environment: "staging", status: "a_word_gitlab_adds", sha: SHA("b") });
    mountPage(s.client);
    expect(words(await box("staging"))).toMatch(/Last attempt.*a word gitlab adds.*bbbbbbbb/);
  });

  test("with nothing deployed anywhere it says how deployments get here", async () => {
    const s = await sceneOn(backend, { environments: [] });
    mountPage(s.client);
    const c = await card();
    expect(words(c)).toContain("docker-deploy");
    expect(words(c)).toContain("Deployment events");
    expect(within(c).queryAllByRole("heading", { level: 3 })).toEqual([]);
    expect(within(c).getByRole("button", { name: "Refresh" })).toBeDefined();
  });

  test("a GitLab environment this project does not have is one plain line", async () => {
    const s = await sceneOn(backend, { environments: ["staging"] });
    await deployed(s, { environment: "staging", status: "success", sha: SHA("a") });
    await deployed(s, { environment: "legacy-prod", status: "success", sha: SHA("b") });
    await deployed(s, { environment: "legacy-prod", status: "failed", sha: SHA("c") });
    mountPage(s.client);
    const c = await card();
    await within(c).findByRole("heading", { name: "staging" });
    const line = within(c).getByText(/not environments of this project/);
    expect(words(line)).toContain("legacy-prod");
    expect(words(line).match(/legacy-prod/g)).toHaveLength(1);
    expect(words(line)).not.toContain("bbbbbbbb"); // by name only
  });

  test("the pipeline is a link when the platform knows that run, and absent when it does not", async () => {
    const s = await sceneOn(backend, { environments: ["staging", "production"] });
    await recordPipelineRun(backend.t.db, {
      organizationId: s.org.id,
      projectId: s.project.id,
      connectionId: null,
      gitlabPipelineId: 8801,
      iid: 41,
      status: "success",
      ref: "main",
      sha: SHA("a"),
      webUrl: "https://gitlab.example/acme/web/-/pipelines/8801",
      failureReason: null,
      failedJob: null,
      observedAt: new Date(),
    });
    await deployed(s, {
      environment: "staging",
      status: "success",
      sha: SHA("a"),
      pipelineId: 8801,
    });
    await deployed(s, {
      environment: "production",
      status: "success",
      sha: SHA("b"),
      pipelineId: 9999, // no run of it is stored
    });
    mountPage(s.client);
    const staging = await box("staging");
    const link = await within(staging).findByRole("link", { name: /pipeline #41/i });
    expect(link.getAttribute("href")).toBe("https://gitlab.example/acme/web/-/pipelines/8801");
    await waitFor(() => expect(within(staging).queryAllByRole("link")).toHaveLength(1));
    expect(within(await box("production")).queryAllByRole("link")).toEqual([]);
  });
});

// DEP-21: the numbers of DEP-20 under each box, in words with their units.
describe("the numbers under each box", () => {
  const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);
  const when = (hours: number) => ({ finishedAt: ago(hours), observedAt: ago(hours) });

  test("how often, how many failed of how many and how long a fix took, with units; nothing is a dash", async () => {
    const s = await sceneOn(backend, { environments: ["Staging", "Production", "QA"] });
    // a failure fixed twelve hours later: three that succeeded and one that failed
    await deployed(s, { environment: "staging", status: "success", sha: SHA("a"), ...when(72) });
    await deployed(s, { environment: "staging", status: "failed", sha: SHA("b"), ...when(48) });
    await deployed(s, { environment: "staging", status: "success", sha: SHA("c"), ...when(36) });
    await deployed(s, { environment: "staging", status: "success", sha: SHA("d"), ...when(1) });
    await deployed(s, { environment: "qa", status: "failed", sha: SHA("e"), ...when(2) });
    mountPage(s.client);
    const line = await within(await box("Staging")).findByText(
      "0.7 deployments a week · 1 failed in 4 · back in 12 h",
    );
    expect(line.getAttribute("title")).toBe("The last 30 days");
    expect((await within(await box("QA")).findByText(/failed in 1/)).textContent).toBe(
      "0 deployments a week · 1 failed in 1 · back in -",
    );
    expect((await within(await box("Production")).findByText("-")).tagName).toBe("P");
  });

  test("a deployment older than the window is not in the numbers", async () => {
    const s = await sceneOn(backend, { environments: ["staging"] });
    await deployed(s, {
      environment: "staging",
      status: "success",
      sha: SHA("a"),
      ...when(24 * 40),
    });
    mountPage(s.client);
    expect(words(await box("staging"))).toContain("aaaaaaaa");
    expect((await within(await box("staging")).findByText("-")).tagName).toBe("P");
  });

  test("when the numbers cannot be read the boxes stay, and it says so instead of a dash", async () => {
    const s = await sceneOn(backend, { environments: ["staging"] });
    await deployed(s, { environment: "staging", status: "success", sha: SHA("a"), ...when(1) });
    const client = clientVia(backend.api, s.cookie, async (request, send) =>
      pathOf(request).endsWith("/deployments/stats") ? down("the numbers broke") : send(),
    );
    mountPage(client);
    expect(words(await box("staging"))).toContain("aaaaaaaa");
    expect((await screen.findByText(/Could not read the numbers/)).textContent).toContain(
      "the numbers broke",
    );
    expect(within(await box("staging")).queryByText("-")).toBeNull();
  });
});

describe("Refresh", () => {
  /** The scene's project on a mock GitLab with a connection, and a deployment of it that names the connection. */
  async function live(s: Scene, when?: Date) {
    const mock = backend.gitlab(undefined, ["api"]);
    const gl = mock.addProject({ path: `fx/deploys-${++id}` });
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
    await deployed(s, {
      environment: "staging",
      status: "success",
      sha: SHA("a"),
      connectionId: connection.id,
      gitlabDeploymentId: 1, // older than anything the mock adds
      ...(when ? { finishedAt: when, observedAt: when } : {}),
    });
    return { mock, gl };
  }
  const audited = (s: Scene) =>
    backend.t.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, "deployment.refresh"), eq(auditEvents.organizationId, s.org.id)),
      );

  test("a maintainer reads GitLab's newest, and the box shows what it found", async () => {
    const s = await sceneOn(backend, { environments: ["staging"] });
    const g = await live(s);
    g.mock.addDeployment(g.gl.path, { environment: "staging", sha: SHA("f"), status: "success" });
    const maintainer = await backend.signIn("maintainer", {
      orgRoles: { [s.org.id]: "member" },
      projectRoles: { [s.project.id]: "maintainer" },
    });
    mountPage(maintainer.client);
    expect(words(await box("staging"))).toContain("aaaaaaaa");
    await userEvent.setup().click(within(await card()).getByRole("button", { name: "Refresh" }));
    expect((await screen.findByRole("status")).textContent).toContain("1 new or changed");
    await waitFor(() => expect(words(document.body)).toContain("ffffffff"));
    expect(await audited(s)).toHaveLength(1);
    // what GitLab says of the people and the commit never reaches the page
    for (const word of ["Mock Deployer", "mock-deployer", "mock commit title", "mock@example.test"])
      expect(words(document.body)).not.toContain(word);
  });

  test("the numbers follow what Refresh found", async () => {
    const s = await sceneOn(backend, { environments: ["staging"] });
    const g = await live(s, new Date(Date.now() - 3_600_000));
    g.mock.addDeployment(g.gl.path, { environment: "staging", sha: SHA("f"), status: "success" });
    mountPage(s.client);
    const staging = within(await box("staging"));
    await staging.findByText("0.2 deployments a week · 0 failed in 1 · back in -");
    await userEvent.setup().click(within(await card()).getByRole("button", { name: "Refresh" }));
    await staging.findByText("0.5 deployments a week · 0 failed in 2 · back in -");
  });

  test("a reporter is refused in the API's words, and nothing is read or written", async () => {
    const s = await sceneOn(backend, { reporter: true, environments: ["staging"] });
    const g = await live(s);
    g.mock.addDeployment(g.gl.path, { environment: "staging", sha: SHA("f") });
    mountPage(s.client);
    const before = g.mock.requests.length;
    await userEvent.setup().click(within(await card()).getByRole("button", { name: "Refresh" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /permission|forbidden|not allowed/i,
    );
    expect(words(await box("staging"))).not.toContain("ffffffff");
    expect(g.mock.requests.length).toBe(before);
    expect(await audited(s)).toHaveLength(0);
  });

  test("a project GitLab cannot be asked about is told so, in words", async () => {
    const s = await sceneOn(backend, { environments: [] });
    mountPage(s.client);
    await userEvent.setup().click(within(await card()).getByRole("button", { name: "Refresh" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not imported from GitLab/i);
  });
});

// DEP-14: Promote and Roll back in the box of an environment, each through a dialog that shows the dry run first.
describe("Promote and Roll back", () => {
  /**
   * A project on a mock GitLab that can start a pipeline, set up with docker-deploy, and what GitLab has said:
   * staging has had a then b, production has had a. (Roll back to a is then offered in staging only.)
   */
  async function deployable(s: Scene, over: { template?: string } = {}) {
    const mock = backend.gitlab(undefined, ["api"]);
    const gl = mock.addProject({
      path: `fx/promote-${++id}`,
      files: { ".gitlab-ci.yml": "deploy:\n  script: [echo deploy]\n" },
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
    await savePipelineConfig(backend.t.db, {
      organizationId: s.org.id,
      projectId: s.project.id,
      connectionId: connection.id,
      template: over.template ?? "docker-deploy",
      version: "1.0.0",
      renderedHash: "0".repeat(64),
    });
    for (const [environment, sha] of [
      ["staging", "a"],
      ["staging", "b"],
      ["production", "a"],
    ] as const)
      await deployed(s, { environment, status: "success", sha: SHA(sha) });
    const started = () =>
      mock.requests.filter((r) => r.method === "POST" && /\/pipeline$/.test(r.path));
    return { mock, gl, started };
  }
  const sceneWith = async (options: { reporter?: boolean } = {}) => {
    const s = await sceneOn(backend, { ...options, environments: [] });
    await s.scope.environments.post({ name: "staging", slug: "staging", sortOrder: 1 });
    await s.scope.environments.post({ name: "production", slug: "production", sortOrder: 2 });
    return s;
  };
  const audits = (s: Scene, action: string) =>
    backend.t.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, action), eq(auditEvents.organizationId, s.org.id)));
  const button = async (env: string, name: RegExp) =>
    within(await box(env)).findByRole("button", { name });
  const dialog = async (name: string) => within(await screen.findByRole("dialog", { name }));

  test("Promote shows what the dry run says before Confirm can be pressed, and starts the build the person picked", async () => {
    const s = await sceneWith();
    const g = await deployable(s);
    // a newer build elsewhere (a GitLab environment this project does not have) is offered, but not first
    await deployed(s, { environment: "preview-x", status: "success", sha: SHA("d") });
    mountPage(s.client);
    const user = userEvent.setup();
    await user.click(await button("production", /^promote/i));
    const d = await dialog("Promote to production");
    // the build deployed to the environment before this one is the one offered first
    const pick = (await d.findByRole("combobox", { name: /build/i })) as HTMLSelectElement;
    expect(pick.value).toBe(SHA("b"));
    const confirm = await d.findByRole("button", { name: "Start deployment" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect(words(screen.getByRole("dialog"))).toMatch(/Now.*aaaaaaaa/);
    expect(words(screen.getByRole("dialog"))).toMatch(/Going there.*bbbbbbbb/);
    expect(words(screen.getByRole("dialog"))).toMatch(
      /health check is set up and it fails.*aaaaaaaa.*put back/,
    );
    // asking was a dry run: GitLab was not asked to start anything
    expect(g.started()).toHaveLength(0);
    expect((await audits(s, "deployment.promote")).map((e) => e.metadata)).toEqual([
      {
        environment: "production",
        sha: SHA("b"),
        previous: SHA("a"),
        pipelineId: null,
        dryRun: true,
      },
    ]);

    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(g.started()).toHaveLength(1);
    const [started] = (await audits(s, "deployment.promote")).filter(
      (e) => (e.metadata as { dryRun: boolean }).dryRun === false,
    );
    const pipelineId = ((started?.metadata ?? {}) as { pipelineId?: number }).pipelineId ?? 0;
    expect(g.mock.pipelineVariables(pipelineId)).toEqual([
      { key: "ORCH_DEPLOY_ENV", value: "production", type: "env_var" },
      { key: "ORCH_DEPLOY_SHA", value: SHA("b"), type: "env_var" },
      { key: "ORCH_PREVIOUS_SHA", value: SHA("a"), type: "env_var" },
    ]);
    // the person is told, with a link to the pipeline, and that the box changes when GitLab says so
    const status = await screen.findByRole("status");
    expect(words(status)).toMatch(/Started.*bbbbbbbb.*production/);
    expect(
      within(status)
        .getByRole("link", { name: /pipeline/i })
        .getAttribute("href"),
    ).toMatch(/^http/);
    expect(words(status)).toContain("when GitLab reports it");
    // what GitLab says of the people and the commit never reaches the page
    for (const word of ["Mock Deployer", "mock-deployer", "mock commit title", "mock@example.test"])
      expect(words(document.body)).not.toContain(word);
  });

  test("choosing another build asks again, and Confirm starts exactly that one, once", async () => {
    const s = await sceneWith();
    const g = await deployable(s);
    await deployed(s, { environment: "staging", status: "success", sha: SHA("c") });
    mountPage(s.client);
    const user = userEvent.setup();
    await user.click(await button("production", /^promote/i));
    const d = await dialog("Promote to production");
    const pick = (await d.findByRole("combobox", { name: /build/i })) as HTMLSelectElement;
    // newest first, and not the build that is already there
    await waitFor(() =>
      expect([...pick.options].map((o) => o.value)).toEqual([SHA("c"), SHA("b")]),
    );
    await user.selectOptions(pick, SHA("b"));
    await waitFor(() => expect(words(screen.getByRole("dialog"))).toMatch(/Going there.*bbbbbbbb/));
    const confirm = await d.findByRole("button", { name: "Start deployment" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    await user.dblClick(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(g.started()).toHaveLength(1);
    const applied = (await audits(s, "deployment.promote")).filter(
      (e) => (e.metadata as { dryRun: boolean }).dryRun === false,
    );
    expect(applied.map((e) => (e.metadata as { sha: string }).sha)).toEqual([SHA("b")]);
  });

  test("a refusal is shown in the API's words, Confirm stays shut and nothing is started", async () => {
    const s = await sceneWith();
    const g = await deployable(s);
    await deployed(s, { environment: "production", status: "running", sha: SHA("b") });
    mountPage(s.client);
    await userEvent.setup().click(await button("production", /^promote/i));
    const d = await dialog("Promote to production");
    expect((await d.findByRole("alert")).textContent).toMatch(/still running/i);
    expect(
      (d.getByRole("button", { name: "Start deployment" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(g.started()).toHaveLength(0);
    expect(await audits(s, "deployment.promote")).toHaveLength(0);
  });

  test("a reporter may press the button; the API's refusal is what they read, and nothing is started", async () => {
    const s = await sceneWith({ reporter: true });
    const g = await deployable(s);
    mountPage(s.client);
    await userEvent.setup().click(await button("production", /^promote/i));
    const d = await dialog("Promote to production");
    expect((await d.findByRole("alert")).textContent).toMatch(/permission|forbidden|not allowed/i);
    expect(
      (d.getByRole("button", { name: "Start deployment" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(g.started()).toHaveLength(0);
    expect(await audits(s, "deployment.promote")).toHaveLength(0);
  });

  // DEP-18: a protected environment is entered with an approval, asked for and given in its box
  const protect = async (s: Scene, slug: string) => {
    const [env] = await backend.t.db
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, s.project.id), eq(environments.slug, slug)));
    await setEnvironmentProtection(backend.t.db, s.org.id, s.project.id, env?.id ?? "", true);
    return env?.id ?? "";
  };
  /** The deploy requests of an environment as the API lists them, whoever asked. */
  const requests = async (
    s: Scene,
    envId: string,
    status: "open" | "approved" | "rejected" = "open",
  ) =>
    must(
      await s.scope
        .environments({ envId })
        ["change-requests"].get({ query: { status, limit: 100 } }),
    ).items.filter((r) => r.kind === "deploy");
  /** Someone else (an organization admin) asks to deploy a build into an environment. */
  const askAsSomeoneElse = async (s: Scene, envId: string, sha: string) => {
    const other = await backend.signIn("second admin", {
      orgRoles: { [s.org.id]: "admin" },
      projectRoles: {},
    });
    return must(
      await other.client
        .organizations({ orgId: s.org.id })
        .projects({ projectId: s.project.id })
        .environments({ envId })
        ["change-requests"].post({ kind: "deploy", sha }),
    );
  };

  test("in a protected environment the dialog asks for approval, once, and the box then shows the request without Approve", async () => {
    const s = await sceneWith();
    const g = await deployable(s);
    const envId = await protect(s, "production");
    mountPage(s.client);
    const user = userEvent.setup();
    const production = await box("production");
    await within(production).findByText("Protected");
    expect(
      (within(production).getByRole("button", { name: /^promote/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await user.click(await button("production", /^promote/i));
    const d = await dialog("Promote to production");
    const ask = await d.findByRole("button", { name: "Ask for approval" });
    await waitFor(() => expect((ask as HTMLButtonElement).disabled).toBe(false));
    expect(words(screen.getByRole("dialog"))).toMatch(/protected.*someone other than you/i);
    await user.dblClick(ask);
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    // one request for the build the dialog showed, and nothing started in GitLab
    const [asked, ...rest] = await requests(s, envId);
    expect(rest).toHaveLength(0);
    expect(asked?.subject).toEqual({ sha: SHA("b") });
    expect(g.started()).toHaveLength(0);
    expect(words(await screen.findByRole("status"))).toMatch(
      /Asked for approval.*bbbbbbbb.*production/,
    );
    // the box lists it; its author cannot approve it, but may withdraw it
    const waiting = await within(await box("production")).findByText(/You asked/);
    expect(waiting).toBeTruthy();
    expect(within(await box("production")).queryByRole("button", { name: /^Approve/ })).toBeNull();
    expect(
      within(await box("production")).getByRole("button", { name: /^Reject bbbbbbbb/ }),
    ).toBeTruthy();
    // asking again is not offered while the request waits
    await user.click(await button("production", /^promote/i));
    const again = await (await dialog("Promote to production")).findByRole("button", {
      name: "Waiting for approval",
    });
    expect((again as HTMLButtonElement).disabled).toBe(true);
  });

  test("another person approves it in the box, and then Promote starts that build and uses the approval up", async () => {
    const s = await sceneWith();
    const g = await deployable(s);
    const envId = await protect(s, "production");
    const request = await askAsSomeoneElse(s, envId, SHA("b"));
    mountPage(s.client);
    const user = userEvent.setup();
    const production = await box("production");
    await within(production).findByText("Waiting for approval");
    await user.click(
      within(production).getByRole("button", { name: "Approve bbbbbbbb for production" }),
    );
    await within(await box("production")).findByText(/Approved: Promote or Roll back starts it/);
    expect(await requests(s, envId, "approved")).toHaveLength(1);
    // the dialog now starts it
    await user.click(await button("production", /^promote/i));
    const d = await dialog("Promote to production");
    const start = await d.findByRole("button", { name: "Start deployment" });
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await user.click(start);
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(g.started()).toHaveLength(1);
    const [started] = (await audits(s, "deployment.promote")).filter(
      (e) => (e.metadata as { dryRun: boolean }).dryRun === false,
    );
    expect(((started?.metadata ?? {}) as { changeRequestId?: string }).changeRequestId).toBe(
      request.id,
    );
    // the request is spent, and the box no longer lists it
    expect(await requests(s, envId, "approved")).toHaveLength(0);
    await waitFor(() =>
      expect(words(within(document.body).getByRole("region", { name: "Deployments" }))).not.toMatch(
        /Approved: Promote/,
      ),
    );
    for (const word of ["Mock Deployer", "mock-deployer", "mock commit title", "mock@example.test"])
      expect(words(document.body)).not.toContain(word);
  });

  test("an approval for another build does not start this one: the dialog asks again", async () => {
    const s = await sceneWith();
    const g = await deployable(s);
    await deployed(s, { environment: "staging", status: "success", sha: SHA("c") });
    const envId = await protect(s, "production");
    const request = await askAsSomeoneElse(s, envId, SHA("b"));
    must(
      await s.scope.environments({ envId })["change-requests"]({ crId: request.id }).approve.post(),
    );
    mountPage(s.client);
    const user = userEvent.setup();
    await user.click(await button("production", /^promote/i));
    const d = await dialog("Promote to production");
    // newest first: c is offered, b (approved) is not the pick
    const pick = (await d.findByRole("combobox", { name: /build/i })) as HTMLSelectElement;
    await waitFor(() => expect(pick.value).toBe(SHA("c")));
    await d.findByRole("button", { name: "Ask for approval" });
    await user.selectOptions(pick, SHA("b"));
    await d.findByRole("button", { name: "Start deployment" });
    expect(g.started()).toHaveLength(0);
  });

  test("Reject takes a request out of the box", async () => {
    const s = await sceneWith();
    await deployable(s);
    const envId = await protect(s, "production");
    await askAsSomeoneElse(s, envId, SHA("b"));
    mountPage(s.client);
    const production = await box("production");
    await userEvent
      .setup()
      .click(
        await within(production).findByRole("button", { name: "Reject bbbbbbbb for production" }),
      );
    await waitFor(() =>
      expect(within(production).queryByText("Waiting for approval") === null).toBe(true),
    );
    expect(await requests(s, envId)).toHaveLength(0);
    expect(await requests(s, envId, "rejected")).toHaveLength(1);
  });

  test("Roll back in a protected environment asks for the build it would restore", async () => {
    const s = await sceneWith();
    const g = await deployable(s); // staging: a then b, so a is the way back
    const envId = await protect(s, "staging");
    mountPage(s.client);
    const user = userEvent.setup();
    await user.click(await button("staging", /^roll back/i));
    const d = await dialog("Roll back staging");
    const ask = await d.findByRole("button", { name: "Ask for approval" });
    await waitFor(() => expect((ask as HTMLButtonElement).disabled).toBe(false));
    await user.click(ask);
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect((await requests(s, envId)).map((r) => r.subject)).toEqual([{ sha: SHA("a") }]);
    expect(g.started()).toHaveLength(0);
  });

  test("a refusal to approve (a reporter) is shown in the API's words, and the request stays", async () => {
    const s = await sceneWith({ reporter: true });
    await deployable(s);
    const envId = await protect(s, "production");
    await askAsSomeoneElse(s, envId, SHA("b"));
    mountPage(s.client);
    const production = await box("production");
    await userEvent
      .setup()
      .click(
        await within(production).findByRole("button", { name: "Approve bbbbbbbb for production" }),
      );
    expect((await within(production).findByRole("alert")).textContent).toMatch(
      /permission|forbidden|not allowed/i,
    );
    expect(await requests(s, envId)).toHaveLength(1);
  });

  test("Roll back is offered where there is a build to go back to, and nowhere else", async () => {
    const s = await sceneWith();
    await deployable(s); // staging a then b; production a only
    mountPage(s.client);
    await within(await box("staging")).findByRole("button", { name: /^roll back/i });
    expect(
      within(await box("production")).queryByRole("button", { name: /^roll back/i }),
    ).toBeNull();
  });

  test("an environment with nothing deployed offers Promote and no Roll back", async () => {
    const s = await sceneWith();
    mountPage(s.client);
    const staging = await box("staging");
    await within(staging).findByText(/Nothing has been deployed here yet/);
    expect(within(staging).getByRole("button", { name: /^promote/i })).toBeDefined();
    expect(within(staging).queryByRole("button", { name: /^roll back/i })).toBeNull();
  });

  test("Roll back names the build it goes back to and says data is not undone; Confirm starts it as a rollback", async () => {
    const s = await sceneWith();
    const g = await deployable(s);
    mountPage(s.client);
    const user = userEvent.setup();
    await user.click(await button("staging", /^roll back/i));
    const d = await dialog("Roll back staging");
    const confirm = await d.findByRole("button", { name: "Start rollback" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    expect(words(screen.getByRole("dialog"))).toMatch(/Now.*bbbbbbbb/);
    expect(words(screen.getByRole("dialog"))).toMatch(/Going back to.*aaaaaaaa/);
    expect(words(screen.getByRole("dialog"))).toMatch(/data.*not undone/i);
    expect(g.started()).toHaveLength(0);
    await user.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(g.started()).toHaveLength(1);
    const applied = (await audits(s, "deployment.rollback")).filter(
      (e) => (e.metadata as { dryRun: boolean }).dryRun === false,
    );
    expect(applied).toHaveLength(1);
    expect(await audits(s, "deployment.promote")).toHaveLength(0);
    const pipelineId = ((applied[0]?.metadata ?? {}) as { pipelineId?: number }).pipelineId ?? 0;
    expect(g.mock.pipelineVariables(pipelineId)).toEqual([
      { key: "ORCH_DEPLOY_ENV", value: "staging", type: "env_var" },
      { key: "ORCH_DEPLOY_SHA", value: SHA("a"), type: "env_var" },
      { key: "ORCH_PREVIOUS_SHA", value: SHA("b"), type: "env_var" },
    ]);
  });

  test("the dialog closes on Escape and the focus goes back to the button that opened it", async () => {
    const s = await sceneWith();
    const g = await deployable(s);
    mountPage(s.client);
    const user = userEvent.setup();
    const opener = await button("production", /^promote/i);
    opener.focus();
    await user.click(opener);
    const d = await dialog("Promote to production");
    await d.findByRole("button", { name: "Start deployment" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(document.activeElement).toBe(opener);
    expect(g.started()).toHaveLength(0);
  });
});
