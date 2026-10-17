import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { projects } from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eq } from "drizzle-orm";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { OrgProvider, RequireOrg } from "./org";
import { PipelinePage } from "./pipeline";
import { initialValues, lineDiff, paramsOf, webUrl } from "./pipeline-parts";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";
import { must, SECRET, scene as sceneOn } from "./variables.fixture";

const FILE = ".gitlab-ci.yml";
const BRANCH = "orch/pipeline";

// A catalog of the tests' own: a template with a parameter of every type, one the project's kind
// suits less, one GitLab's lint refuses, and one that takes nothing.
const CATALOG: NonNullable<Parameters<typeof startBackend>[0]> = [
  {
    manifest: {
      name: "web-app",
      version: "1.0.0",
      description: "A web app, with a parameter of every type.",
      params: {
        type: "object",
        properties: {
          image: {
            type: "string",
            description: "Image tag.",
            default: "20",
            pattern: "^[0-9]{1,3}$",
          },
          flavour: { type: "string", enum: ["slim", "full"], default: "slim" },
          retries: { type: "integer", minimum: 0, maximum: 5, default: 2 },
          ratio: { type: "number", minimum: 0, maximum: 1 },
          cache: { type: "boolean", default: true },
          lint: { type: "boolean" },
          team: { type: "string", description: "Who owns it.", pattern: "^[a-z]{2,10}$" },
        },
        required: ["team"],
      },
      detects: ["node"],
      requiresVariables: ["DEPLOY_TOKEN"],
    },
    pipeline: [
      "stages:",
      "  - test",
      "test:",
      "  stage: test",
      '  image: "node:{{ params.image }}"',
      '  retry: "{{ params.retries }}"',
      "  script:",
      '    - "echo {{ params.flavour }} {{ params.team }}"',
      "",
    ].join("\n"),
  },
  {
    manifest: {
      name: "plain-app",
      version: "1.0.0",
      description: "A project that needs nothing but tests.",
      params: { type: "object", properties: {}, required: [] },
      detects: ["bun"],
      requiresVariables: [],
    },
    pipeline: "stages:\n  - test\ntest:\n  stage: test\n  script:\n    - bun test\n",
  },
  {
    manifest: {
      name: "broken-app",
      version: "1.0.0",
      description: "A pipeline whose job has no script.",
      params: { type: "object", properties: {}, required: [] },
      detects: [],
      requiresVariables: [],
    },
    pipeline: "stages:\n  - test\nlonely:\n  stage: test\n",
  },
  {
    manifest: {
      name: "docs-site",
      version: "1.0.0",
      description: "Publishes the documentation.",
      params: { type: "object", properties: {}, required: [] },
      detects: [],
      requiresVariables: [],
    },
    pipeline: "stages:\n  - pages\npages:\n  stage: pages\n  script:\n    - echo docs\n",
  },
];

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend(CATALOG);
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/pipeline";
  try {
    localStorage.clear();
  } catch {
    // the page copes without it
  }
});

type Types = { tag: "bun" | "node"; confidence: "high" | "medium"; evidence: string[] }[];
const NODE_AND_BUN: Types = [
  { tag: "bun", confidence: "medium", evidence: ["bun.lock"] },
  { tag: "node", confidence: "high", evidence: ["package.json"] },
];

let n = 0;
/**
 * A project of the scene on a GitLab project of its own (the mock), seen as a Node and Bun project,
 * and a connection that reaches it, unless told otherwise.
 */
async function world(
  options: {
    reporter?: boolean;
    types?: Types;
    files?: Record<string, string>;
    connection?: boolean;
    linked?: boolean;
    lintWarnings?: string[];
  } = {},
) {
  const s = await sceneOn(backend, { reporter: options.reporter });
  const mock = backend.gitlab(undefined, ["api"], options.lintWarnings);
  const gl = mock.addProject({
    path: `fx/pipe-${++n}`,
    ...(options.files ? { files: options.files } : {}),
  });
  mock.addMember({ project: gl.id }, mock.tokenUser.id, 40);
  await backend.t.db
    .update(projects)
    .set({
      detectedTypes: options.types ?? NODE_AND_BUN,
      ...(options.linked === false ? {} : { gitlabProjectId: gl.id }),
    })
    .where(eq(projects.id, s.project.id));
  const connect = async (name: string) =>
    must(
      await s.admin.client.organizations({ orgId: s.org.id }).connections.post({
        type: "gitlab",
        name,
        baseUrl: mock.url,
        token: mock.token,
      }),
    );
  const connection = options.connection === false ? undefined : await connect("Mock GitLab");
  const gitlab = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  let seen = 0;
  const pipeline = s.scope.pipeline;
  return {
    ...s,
    mock,
    gl,
    gitlab,
    connection,
    connect,
    pipeline,
    /** The file on a branch of the GitLab project, or null. */
    file: async (ref: string) =>
      (await gitlab.repository.getFile(gl.id, FILE, ref).catch(() => undefined))?.content ?? null,
    mrs: async () => {
      const found = [];
      for await (const m of gitlab.mergeRequests.list(gl.id)) found.push(m);
      return found;
    },
    /** What the project is applied with through the API, as a set-up that is not the screen's doing. */
    applyVia: async (body: Record<string, unknown>) =>
      must(
        await pipeline.post({
          connectionId: connection?.id ?? "",
          template: "web-app",
          params: { team: "ops" },
          ...body,
        }),
      ),
    /** Requests that changed the GitLab project since `mark`. */
    writes: () =>
      mock.requests
        .slice(seen)
        .filter(
          (r) =>
            r.method !== "GET" &&
            r.path.includes(`/projects/${gl.id}/`) &&
            !r.path.endsWith("/ci/lint"),
        ).length,
    mark: () => {
      seen = mock.requests.length;
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** The client of a scene, noting each POST it makes, and letting a test answer a request itself. */
function via(
  w: World,
  hook: (
    request: Request,
    path: string,
  ) => Response | Promise<Response | undefined> | undefined = () => undefined,
) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const client = clientVia(backend.api, w.cookie, async (request, send) => {
    const path = pathOf(request);
    if (request.method === "POST") {
      posts.push({
        path,
        body: await request
          .clone()
          .json()
          .catch(() => ({})),
      });
    }
    return (await hook(request, path)) ?? send();
  });
  return {
    client,
    previews: () => posts.filter((p) => p.path.endsWith("/pipeline/preview")),
    applies: () => posts.filter((p) => p.path.endsWith("/pipeline")),
  };
}

function mountPage(client: ReturnType<Backend["anonymous"]>) {
  const queries = newQueryClient();
  render(
    <Providers client={client} queries={queries}>
      <AuthGate>
        <OrgProvider>
          <RequireOrg>{(org) => <PipelinePage orgId={org.id} />}</RequireOrg>
        </OrgProvider>
      </AuthGate>
    </Providers>,
  );
  return queries;
}

type User = ReturnType<typeof userEvent.setup>;
const detect = () => screen.findByRole("region", { name: "Step 1: Detect" });
const review = () => screen.findByRole("region", { name: "Step 4: Review" });
const form = () => screen.findByRole("form", { name: "Step 3: Parameters" });
const button = (name: string | RegExp) => screen.findByRole("button", { name });
const radios = () =>
  screen
    .getAllByRole("radio")
    .map((r) => r.closest("label")?.querySelector("strong")?.textContent ?? "");

/** From the first step to the parameters of a template. */
async function toParams(user: User, template: string) {
  await user.click(await button("Choose a template"));
  await user.click(await screen.findByRole("radio", { name: new RegExp(`^${template} `) }));
  await user.click(screen.getByRole("button", { name: "Next" }));
  return form();
}
/** Fills the one required parameter of web-app. */
const team = (user: User, value = "ops") => user.type(screen.getByLabelText("team"), value);
async function preview(user: User) {
  const go = (await button("Preview pipeline")) as HTMLButtonElement;
  // the connections arrive after the form does
  await waitFor(() => expect(go.disabled).toBe(false));
  await user.click(go);
  return review();
}
const create = async (user: User) => {
  await user.click(await button(/^(Create merge request|Save without a merge request)$/));
  return screen.findByRole("region", { name: "Result" });
};
const diff = () => screen.getByRole("figure", { name: `Changes to ${FILE}` });
const lines = (kind: string) =>
  Array.from(diff().querySelectorAll(`.diff-${kind}`)).map((l) => l.textContent);

describe("the first step", () => {
  test("the page is in the navigation and shows what was detected and what suits it", async () => {
    const w = await world();
    mount(w.client);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Pipeline" }).getAttribute("aria-current")).toBe(
      "page",
    );
    const step = await detect();
    expect(step.textContent).toContain("bun (likely)");
    expect(step.textContent).toContain("node");
    expect(step.textContent).toContain("No pipeline has been set up from here yet.");
    const suggested = within(step)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(suggested).toEqual([
      "web-app 1.0.0: high confidence, because node (package.json)",
      "plain-app 1.0.0: medium confidence, because bun (bun.lock)",
    ]);
    const steps = within(screen.getByRole("list", { name: "Steps" }));
    expect(steps.getAllByRole("listitem").map((li) => li.getAttribute("aria-current"))).toEqual([
      "step",
      null,
      null,
      null,
    ]);
  });

  test("a project nothing fits says so, and every template is still on offer", async () => {
    const w = await world({ types: [] });
    mountPage(w.client);
    const step = await detect();
    expect(step.textContent).toContain("No template is a clear fit");
    await userEvent.setup().click(await button("Choose a template"));
    expect(radios()).toEqual(["broken-app", "docs-site", "plain-app", "web-app"]);
    expect(screen.queryByText("Recommended")).toBeNull();
  });

  test("a project already set up shows its merge request, a link to GitLab", async () => {
    const w = await world();
    const { mr } = await w.applyVia({});
    if (!mr) throw new Error("no merge request was opened");
    mountPage(w.client);
    const step = await detect();
    expect(step.textContent).toContain("Set up with web-app 1.0.0");
    const link = within(step).getByRole("link", { name: `merge request !${mr.iid}` });
    expect(link.getAttribute("href")).toBe(mr.url);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
  });

  test("an address that is not a web address is not made a link", async () => {
    const w = await world();
    await w.applyVia({});
    const rigged = via(w, async (request, path) => {
      if (request.method !== "GET" || !path.endsWith("/pipeline")) return undefined;
      const body = await (await fetch(request.clone())).json();
      return Response.json({ ...body, config: { ...body.config, mrUrl: "javascript:alert(1)" } });
    });
    mountPage(rigged.client);
    const step = await detect();
    expect(step.textContent).toContain("merge request !1");
    expect(within(step).queryByRole("link")).toBeNull();
    expect(webUrl("javascript:alert(1)")).toBeUndefined();
    expect(webUrl("not a url")).toBeUndefined();
    expect(webUrl("https://gitlab.example/x/-/merge_requests/1")).toBeDefined();
  });
});

describe("choosing a template", () => {
  test("the suggested ones come first and are tagged, and the surest is chosen", async () => {
    const w = await world();
    mountPage(w.client);
    const user = userEvent.setup();
    await user.click(await button("Choose a template"));
    expect(radios()).toEqual(["web-app", "plain-app", "broken-app", "docs-site"]);
    const chosen = screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked);
    expect(chosen).toHaveLength(1);
    expect(chosen[0]?.closest("label")?.textContent).toContain("web-app");
    expect(screen.getAllByText("Recommended")).toHaveLength(2);
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("with nothing suggested none is chosen, and Next waits for a choice", async () => {
    const w = await world({ types: [] });
    mountPage(w.client);
    const user = userEvent.setup();
    await user.click(await button("Choose a template"));
    expect(screen.getAllByRole("radio").some((r) => (r as HTMLInputElement).checked)).toBe(false);
    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await user.click(screen.getByRole("radio", { name: /^docs-site / }));
    expect(next.disabled).toBe(false);
  });

  test("the template a project was set up with is chosen again", async () => {
    const w = await world();
    await w.applyVia({ template: "docs-site", params: {} });
    mountPage(w.client);
    const user = userEvent.setup();
    await user.click(await button("Choose a template"));
    const chosen = screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).checked);
    expect(chosen.map((r) => r.closest("label")?.querySelector("strong")?.textContent)).toEqual([
      "docs-site",
    ]);
  });
});

describe("the parameters", () => {
  test("each is asked for by its type, with the template's own hints", async () => {
    const w = await world();
    mountPage(w.client);
    const user = userEvent.setup();
    const f = await toParams(user, "web-app");
    const field = (name: string) => within(f).getByLabelText(name) as HTMLInputElement;
    const hint = (name: string) =>
      document.getElementById(field(name).getAttribute("aria-describedby") ?? "")?.textContent;

    expect(field("image").value).toBe("20");
    expect(field("image").maxLength).toBe(1000);
    expect(hint("image")).toContain("Image tag.");
    expect(hint("image")).toContain("Default: 20.");
    expect(hint("image")).toContain("Must match ^[0-9]{1,3}$.");
    expect(field("image").hasAttribute("pattern")).toBe(false); // the API says what is wrong, in words

    const flavour = within(f).getByLabelText("flavour") as HTMLSelectElement;
    expect(flavour.tagName).toBe("SELECT");
    expect(Array.from(flavour.options).map((o) => o.value)).toEqual(["slim", "full"]);
    expect(flavour.value).toBe("slim");

    expect(field("retries").type).toBe("number");
    expect([field("retries").min, field("retries").max, field("retries").step]).toEqual([
      "0",
      "5",
      "1",
    ]);
    expect(field("retries").value).toBe("2");
    expect([field("ratio").type, field("ratio").step, field("ratio").value]).toEqual([
      "number",
      "any",
      "",
    ]);
    expect([field("cache").type, field("cache").checked]).toEqual(["checkbox", true]);
    expect(field("lint").checked).toBe(false);
    expect(field("team").required).toBe(true);
    expect(hint("team")).toContain("Required.");

    expect(within(f).getByRole("option", { name: "Mock GitLab" })).toBeDefined();
    expect(f.textContent).toContain("Do not put a secret here");
  });

  test("only what differs from the defaults is sent, in the type the template declares", async () => {
    const w = await world();
    const spy = via(w);
    mountPage(spy.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user);
    await user.selectOptions(screen.getByLabelText("flavour"), "full");
    await user.clear(screen.getByLabelText("retries"));
    await user.type(screen.getByLabelText("retries"), "3");
    await user.type(screen.getByLabelText("ratio"), "0.5");
    await user.click(screen.getByLabelText("lint"));
    await user.click(screen.getByLabelText("cache"));
    await preview(user);
    expect(spy.previews()).toHaveLength(1);
    expect(spy.previews()[0]?.body).toEqual({
      connectionId: w.connection?.id,
      template: "web-app",
      version: "1.0.0",
      params: { team: "ops", flavour: "full", retries: 3, ratio: 0.5, lint: true, cache: false },
    });
  });

  test("the form is built from the template, and the helpers agree with it", () => {
    const [web] = CATALOG;
    const t = {
      name: "web-app",
      version: "1.0.0",
      description: "",
      params: {
        properties: web?.manifest.params.properties ?? {},
        required: ["team", "lint"],
      },
      requiresVariables: [],
    };
    expect(initialValues(t)).toEqual({
      image: "20",
      flavour: "slim",
      retries: "2",
      ratio: "",
      cache: true,
      lint: false,
      team: "",
    });
    // what a project was set up with comes before the default, a `false` included
    expect(initialValues(t, { cache: false, retries: 4 })).toMatchObject({
      cache: false,
      retries: "4",
    });
    // nothing differs from the defaults: nothing is sent, except what is required
    expect(paramsOf(t, { ...initialValues(t), team: "ops" })).toEqual({ team: "ops", lint: false });
    // a value that happens to read like JavaScript's idea of nothing is still a value, when the
    // parameter has no default to compare it with
    const optional = {
      ...t,
      params: { properties: { note: { type: "string" as const } }, required: [] },
    };
    expect(paramsOf(optional, { note: "undefined" })).toEqual({ note: "undefined" });
    expect(paramsOf(optional, { note: "" })).toEqual({});
  });

  test("what the API says is wrong is shown on this step, and the form keeps what was typed", async () => {
    const w = await world();
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user, "NOT ALLOWED");
    await user.click(await button("Preview pipeline"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("team");
    expect(screen.queryByRole("region", { name: "Step 4: Review" })).toBeNull();
    expect((screen.getByLabelText("team") as HTMLInputElement).value).toBe("NOT ALLOWED");
    expect(w.writes()).toBe(0);

    await user.clear(screen.getByLabelText("team"));
    await team(user);
    await user.click(await button("Preview pipeline"));
    await review();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a project set up before shows what it was set up with, and the connection it used", async () => {
    const w = await world();
    const other = await w.connect("Other GitLab");
    await w.applyVia({ connectionId: other.id, params: { team: "ops", image: "18" } });
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    expect((screen.getByLabelText("image") as HTMLInputElement).value).toBe("18");
    expect((screen.getByLabelText("team") as HTMLInputElement).value).toBe("ops");
    await waitFor(() =>
      expect((screen.getByLabelText("GitLab connection") as HTMLSelectElement).value).toBe(
        other.id,
      ),
    );
  });

  test("without a GitLab connection it says so and cannot preview", async () => {
    const w = await world({ connection: false });
    mountPage(w.client);
    const f = await toParams(userEvent.setup(), "web-app");
    await waitFor(() => expect(f.textContent).toContain("no GitLab connection yet"));
    expect(within(f).getByRole("link", { name: "Add one" }).getAttribute("href")).toBe(
      "#/projects",
    );
    expect(
      (within(f).getByRole("button", { name: "Preview pipeline" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("connections that cannot be read are an error, not an empty list", async () => {
    const w = await world();
    const rigged = via(w, (request, path) =>
      request.method === "GET" && path.endsWith("/connections")
        ? down("connections are down")
        : undefined,
    );
    mountPage(rigged.client);
    const f = await toParams(userEvent.setup(), "web-app");
    await waitFor(() => expect(f.textContent).toContain("connections are down"));
    expect(f.textContent).not.toContain("no GitLab connection yet");
  });
});

describe("the review", () => {
  test("shows the file as a diff and has committed nothing", async () => {
    const w = await world();
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user);
    w.mark();
    const step = await preview(user);
    expect(step.textContent).toContain("Review .gitlab-ci.yml from web-app 1.0.0");
    expect(step.textContent).toContain(
      `The default branch has no ${FILE}. The merge request adds it.`,
    );
    expect(lines("add").join("\n")).toContain("image: node:20");
    expect(lines("add").join("\n")).toContain("echo slim ops");
    expect(lines("del")).toEqual([]);
    expect(within(diff()).getByText(/\d+ added, 0 removed\./)).toBeDefined();
    expect(w.writes()).toBe(0);
    expect(await w.mrs()).toEqual([]);
    expect(await w.file(BRANCH)).toBeNull();
    expect(await w.audit("pipeline.apply")).toHaveLength(0);
  });

  test("a variable the pipeline needs is listed for each environment that lacks it, and does not block", async () => {
    const w = await world();
    await w.put.env("dev", "DEPLOY_TOKEN", SECRET, true);
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user);
    await preview(user);
    const missing = screen.getByRole("region", { name: "Missing variables" });
    const items = within(missing)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual(["Not set for staging: DEPLOY_TOKEN"]);
    expect(
      within(missing)
        .getByRole("link", { name: /Variables page/ })
        .getAttribute("href"),
    ).toBe("#/variables");
    expect(
      (screen.getByRole("button", { name: "Create merge request" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("a variable set for the whole project leaves nothing to warn of", async () => {
    const w = await world();
    await w.put.project("DEPLOY_TOKEN", SECRET, true);
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user);
    await preview(user);
    expect(screen.queryByRole("region", { name: "Missing variables" })).toBeNull();
  });

  test("lint errors are shown, and no merge request can be created while they stand", async () => {
    const w = await world();
    const spy = via(w);
    mountPage(spy.client);
    const user = userEvent.setup();
    await toParams(user, "broken-app");
    w.mark();
    await preview(user);
    const errors = screen.getByRole("region", { name: "Lint errors" });
    expect(errors.textContent).toContain("jobs:lonely config should implement the script:");
    expect(errors.textContent).toContain("No merge request can be created");
    const make = screen.getByRole("button", { name: "Create merge request" }) as HTMLButtonElement;
    expect(make.disabled).toBe(true);
    await user.click(make);
    expect(spy.applies()).toEqual([]);
    expect(w.writes()).toBe(0);
    expect(await w.mrs()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Back to parameters" }));
    await form();
  });

  test("lint warnings are shown and do not block", async () => {
    const w = await world({ lintWarnings: ["heads up: nothing runs on tags"] });
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "docs-site");
    await preview(user);
    expect(screen.getByRole("region", { name: "Lint warnings" }).textContent).toContain(
      "heads up: nothing runs on tags",
    );
    expect(screen.queryByRole("region", { name: "Lint errors" })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Create merge request" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("the same lint message twice is listed once", async () => {
    const w = await world({ lintWarnings: ["same thing", "same thing", "another"] });
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "docs-site");
    await preview(user);
    const warnings = screen.getByRole("region", { name: "Lint warnings" });
    expect(
      within(warnings)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["same thing", "another"]);
  });

  test("a file written by hand is never shown here, and the review says it will be replaced", async () => {
    const canary = `SEKRIT-by-hand-${Bun.randomUUIDv7()}`;
    const mine = `stages: [mine]\nmine:\n  stage: mine\n  script: [echo ${canary}]\n`;
    const w = await world({ files: { [FILE]: mine } });
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "docs-site");
    const step = await preview(user);
    expect(step.querySelector("p.warn")?.textContent).toContain("written by hand");
    expect(step.textContent).toContain("replaces it");
    expect(step.textContent).toContain("read the diff in the merge request");
    expect(document.body.textContent).not.toContain(canary);
    expect(lines("del")).toEqual([]);
    expect(lines("add").length).toBeGreaterThan(0);
  });

  test("an earlier file of ours is compared with the new one line by line", async () => {
    const first = await world();
    const text = must(
      await first.pipeline.preview.post({
        connectionId: first.connection?.id ?? "",
        template: "web-app",
        params: { team: "ops" },
      }),
    ).text;
    const w = await world({ files: { [FILE]: text.replace("node:20", "node:18") } });
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user);
    const step = await preview(user);
    expect(step.textContent).toContain("earlier");
    expect(step.textContent).toContain("updates it");
    // each line is its sign, a space, then the line of the file with its own indent
    expect(lines("del").map((l) => l?.slice(2).trim())).toEqual(["image: node:18"]);
    expect(lines("add").map((l) => l?.slice(2).trim())).toEqual(["image: node:20"]);
    expect(lines("del")[0]?.startsWith("- ")).toBe(true);
    expect(lines("add")[0]?.startsWith("+ ")).toBe(true);
    expect(lines("same").length).toBeGreaterThan(3);
    expect(within(diff()).getByText("1 added, 1 removed.")).toBeDefined();
  });

  test("a file that already is this one can be saved without a merge request", async () => {
    const first = await world();
    const text = must(
      await first.pipeline.preview.post({
        connectionId: first.connection?.id ?? "",
        template: "web-app",
        params: { team: "ops" },
      }),
    ).text;
    const w = await world({ files: { [FILE]: text } });
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user);
    const step = await preview(user);
    expect(step.textContent).toContain("already has exactly this");
    expect(within(diff()).getByText("No changes.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Create merge request" })).toBeNull();
    w.mark();
    const done = await create(user);
    expect(done.textContent).toContain("so there is nothing to merge");
    expect(done.textContent).not.toContain("Nothing was written");
    expect(w.writes()).toBe(0);
    expect(await w.mrs()).toEqual([]);
    expect(must(await w.pipeline.get()).config).toMatchObject({ template: "web-app", mrIid: null });
  });

  test("a project that was set up to include its template is told this writes the whole file", async () => {
    const w = await world();
    await w.applyVia({});
    const rigged = via(w, async (request, path) => {
      if (request.method !== "GET" || !path.endsWith("/pipeline")) return undefined;
      const body = await (await fetch(request.clone())).json();
      return Response.json({ ...body, config: { ...body.config, mode: "include" } });
    });
    mountPage(rigged.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    const step = await preview(user);
    expect(step.textContent).toContain("includes its template from another project");
  });
});

describe("creating the merge request", () => {
  test("opens one merge request from a branch and writes nothing to the default branch", async () => {
    const w = await world();
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user);
    await preview(user);
    w.mark();
    const done = await create(user);
    const [mr, ...rest] = await w.mrs();
    if (!mr) throw new Error("no merge request was opened");
    expect(rest).toEqual([]);
    expect(done.textContent).toContain(`Opened merge request !${mr.iid}.`);
    expect(done.textContent).toContain("Nothing was written to the default branch.");
    const link = within(done).getByRole("link", { name: `merge request !${mr.iid}` });
    expect(link.getAttribute("href")).toBe(mr.webUrl);
    expect(await w.file(BRANCH)).toContain("image: node:20");
    expect(await w.file("main")).toBeNull();
    expect(await w.audit("pipeline.apply")).toHaveLength(1);
    expect(must(await w.pipeline.get()).config).toMatchObject({
      template: "web-app",
      params: { team: "ops" },
      mrIid: mr.iid,
    });
    expect(document.body.textContent).not.toContain(w.mock.token);
  });

  test("running it again with other parameters updates the same merge request", async () => {
    const w = await world();
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user);
    await preview(user);
    await create(user);
    const [first] = await w.mrs();
    if (!first) throw new Error("no merge request was opened");

    await user.click(await button("Start over"));
    const step = await detect();
    expect(within(step).getByRole("link", { name: `merge request !${first.iid}` })).toBeDefined();
    // the form starts from what the project was set up with
    await user.click(await button("Choose a template"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect((await form()) && (screen.getByLabelText("team") as HTMLInputElement).value).toBe("ops");
    await user.clear(screen.getByLabelText("image"));
    await user.type(screen.getByLabelText("image"), "22");
    await preview(user);
    const done = await create(user);

    expect(done.textContent).toContain(`Updated merge request !${first.iid}.`);
    expect(done.textContent).toContain("same merge request as before");
    const all = await w.mrs();
    expect(all.map((m) => [m.iid, m.webUrl])).toEqual([[first.iid, first.webUrl]]);
    expect(await w.file(BRANCH)).toContain("image: node:22");
    expect(await w.file("main")).toBeNull();
    expect(must(await w.pipeline.get()).config?.params).toEqual({ team: "ops", image: "22" });
  });

  test("running it again as it was changes nothing", async () => {
    const w = await world();
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "docs-site");
    await preview(user);
    await create(user);
    const [first] = await w.mrs();
    if (!first) throw new Error("no merge request was opened");
    await user.click(await button("Start over"));
    await toParams(user, "docs-site");
    await preview(user);
    w.mark();
    const done = await create(user);
    expect(done.textContent).toContain(`Nothing changed in merge request !${first.iid}.`);
    expect(done.textContent).toContain("already has this pipeline");
    expect(w.writes()).toBe(0);
    expect(await w.mrs()).toHaveLength(1);
  });

  test("what is sent is what was reviewed: going back drops the review, and the new one is the one applied", async () => {
    const w = await world();
    const spy = via(w);
    mountPage(spy.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    await team(user);
    await preview(user);
    await user.click(screen.getByRole("button", { name: "Back to parameters" }));
    expect(screen.queryByRole("region", { name: "Step 4: Review" })).toBeNull();
    expect((screen.getByLabelText("team") as HTMLInputElement).value).toBe("ops");
    await user.clear(screen.getByLabelText("image"));
    await user.type(screen.getByLabelText("image"), "22");
    const step = await preview(user);
    expect(lines("add").join("\n")).toContain("image: node:22");
    expect(step).toBeDefined();
    await create(user);
    expect(spy.previews()).toHaveLength(2);
    expect(spy.applies()).toHaveLength(1);
    expect(spy.applies()[0]?.body).toEqual(spy.previews()[1]?.body);
    expect(spy.applies()[0]?.body.params).toEqual({ team: "ops", image: "22" });
    expect(await w.file(BRANCH)).toContain("image: node:22");
  });

  test("a double click creates it once", async () => {
    const w = await world();
    const spy = via(w);
    mountPage(spy.client);
    const user = userEvent.setup();
    await toParams(user, "docs-site");
    await preview(user);
    await user.dblClick(await button("Create merge request"));
    await screen.findByRole("region", { name: "Result" });
    expect(spy.applies()).toHaveLength(1);
    expect(await w.mrs()).toHaveLength(1);
  });

  test("an apply that fails is shown on the review, which stays, and can be tried again", async () => {
    const w = await world();
    let refuse = true;
    const spy = via(w, (request, path) =>
      refuse && request.method === "POST" && path.endsWith("/pipeline")
        ? down("GitLab is not answering")
        : undefined,
    );
    mountPage(spy.client);
    const user = userEvent.setup();
    await toParams(user, "docs-site");
    await preview(user);
    await user.click(await button("Create merge request"));
    expect((await screen.findByRole("alert")).textContent).toContain("GitLab is not answering");
    await review();
    expect(screen.queryByRole("region", { name: "Result" })).toBeNull();
    expect(await w.mrs()).toEqual([]);

    refuse = false;
    const done = await create(user);
    expect(done.textContent).toContain("Opened merge request");
    expect(await w.mrs()).toHaveLength(1);
  });
});

describe("what the API refuses", () => {
  test("someone who may not preview is told by the API, and nothing is written", async () => {
    const w = await world({ reporter: true });
    const spy = via(w);
    mountPage(spy.client);
    const user = userEvent.setup();
    await toParams(user, "docs-site");
    await waitFor(() => expect(screen.getByRole("form").textContent).not.toContain("Loading"));
    w.mark();
    const go = screen.getByRole("button", { name: "Preview pipeline" }) as HTMLButtonElement;
    // a member may read the setup but not change it: the connection list or the preview says no
    if (!go.disabled) {
      await user.click(go);
      await screen.findByRole("alert");
    }
    expect(screen.queryByRole("region", { name: "Step 4: Review" })).toBeNull();
    expect(w.writes()).toBe(0);
    expect(spy.applies()).toEqual([]);
  });

  test("a template that leaves the catalog under an open form is said so, with a way back", async () => {
    const w = await world();
    let gone = false;
    const rigged = via(w, async (request, path) => {
      if (!gone || request.method !== "GET" || !path.endsWith("/pipeline")) return undefined;
      const body = await (await fetch(request.clone())).json();
      return Response.json({
        ...body,
        templates: body.templates.filter((t: { name: string }) => t.name !== "web-app"),
      });
    });
    const queries = mountPage(rigged.client);
    const user = userEvent.setup();
    await toParams(user, "web-app");
    gone = true;
    await queries.invalidateQueries();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "web-app is no longer offered",
    );
    expect(screen.queryByRole("form", { name: "Step 3: Parameters" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("region", { name: "Step 2: Template" });
    expect(radios()).not.toContain("web-app");
  });

  test("a project that was not imported from GitLab is refused in the API's words", async () => {
    const w = await world({ linked: false });
    mountPage(w.client);
    const user = userEvent.setup();
    await toParams(user, "docs-site");
    await user.click(await button("Preview pipeline"));
    expect((await screen.findByRole("alert")).textContent).toContain("not imported from GitLab");
    expect(screen.queryByRole("region", { name: "Step 4: Review" })).toBeNull();
  });

  test("when the project's setup cannot be read, the error says so and can be tried again", async () => {
    const w = await world();
    let down500 = true;
    const rigged = via(w, (request, path) =>
      down500 && request.method === "GET" && path.endsWith("/pipeline")
        ? down("pipeline is down")
        : undefined,
    );
    mountPage(rigged.client);
    expect((await screen.findByRole("alert")).textContent).toContain("pipeline is down");
    down500 = false;
    await userEvent.setup().click(await button("Try again"));
    await detect();
  });
});

describe("the line diff", () => {
  const rebuild = (d: ReturnType<typeof lineDiff>, side: "before" | "after") =>
    d
      .filter((l) => l.kind === "same" || l.kind === (side === "before" ? "del" : "add"))
      .map((l) => l.text);

  test("a new file is all added, and equal texts are all the same", () => {
    expect(lineDiff(null, "a\nb\n")).toEqual([
      { kind: "add", text: "a" },
      { kind: "add", text: "b" },
    ]);
    expect(lineDiff("a\nb\n", "a\nb\n").every((l) => l.kind === "same")).toBe(true);
  });

  test("a change, an insertion and a removal are found where they are", () => {
    const kinds = (a: string, b: string) => lineDiff(a, b).map((l) => `${l.kind}:${l.text}`);
    expect(kinds("a\nb\nc\n", "a\nx\nc\n")).toEqual(["same:a", "del:b", "add:x", "same:c"]);
    expect(kinds("a\nc\n", "a\nb\nc\n")).toEqual(["same:a", "add:b", "same:c"]);
    expect(kinds("a\nb\nc\n", "a\nc\n")).toEqual(["same:a", "del:b", "same:c"]);
    // lines that move are removed and added, not lost
    expect(kinds("a\nb\n", "b\na\n")).toHaveLength(3);
  });

  test("the longest run of kept lines wins over the first match", () => {
    // a line that moved to the front: keeping a, b, c and moving x is five lines, not seven
    const d = lineDiff("a\nb\nc\nx\n", "x\na\nb\nc\n");
    expect(d.filter((l) => l.kind === "same").map((l) => l.text)).toEqual(["a", "b", "c"]);
    expect(d).toHaveLength(5);
  });

  test("one changed line in a large file is a one line change", () => {
    // the ends that match are cut off before the search, which is what keeps this one line
    const file = (changed: string) =>
      Array.from({ length: 2000 }, (_, i) => (i === 1500 ? changed : `line ${i}`)).join("\n");
    const d = lineDiff(file("before"), file("after"));
    expect(d.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["before"]);
    expect(d.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["after"]);
    expect(d.filter((l) => l.kind === "same")).toHaveLength(1999);
  });

  test("whatever the texts, the old one and the new one can be read back from it", () => {
    const pairs = [
      ["", "a\n"],
      ["a\n", ""],
      ["a\nb\nc\nd\n", "d\nc\nb\na\n"],
      ["x\ny\nx\ny\n", "y\nx\ny\nx\n"],
      ["a\n\nb\n", "a\nb\n\n"],
    ] as const;
    for (const [before, after] of pairs) {
      const d = lineDiff(before, after);
      expect(rebuild(d, "before")).toEqual(before.replace(/\n$/, "").split("\n"));
      expect(rebuild(d, "after")).toEqual(after.replace(/\n$/, "").split("\n"));
    }
  });

  test("a very large change is still right, if longer than it needs to be", () => {
    const side = (tag: string) => Array.from({ length: 1200 }, (_, i) => `${tag}${i}`).join("\n");
    const d = lineDiff(side("old"), side("new"));
    expect(d.filter((l) => l.kind === "same")).toEqual([]);
    expect(rebuild(d, "before")).toHaveLength(1200);
    expect(rebuild(d, "after")).toHaveLength(1200);
    expect(rebuild(d, "after")[0]).toBe("new0");
  });
});
