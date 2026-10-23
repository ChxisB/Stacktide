import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createProject } from "@orch/db";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Providers } from "./app";
import { AuthGate } from "./auth";
import { OrgProvider, RequireOrg } from "./org";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";
import { VariablesPage } from "./variables";
import {
  addEnvironment,
  addNew,
  cellOf,
  detailsOf,
  editOf,
  fromMenu,
  holding as holdingOn,
  must,
  ref,
  SECRET,
  scene as sceneOn,
  showCompare,
  tagsOf,
} from "./variables.fixture";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
const scene = (options?: { reporter?: boolean; environments?: string[] }) =>
  sceneOn(backend, options);
const holding = (cookie: string) => holdingOn(backend, cookie);
beforeEach(() => {
  window.location.hash = "#/variables";
  try {
    localStorage.clear();
  } catch {
    // the page copes without it
  }
});

/** The page alone, with a short time before a revealed value hides again. */
function mountPage(client: ReturnType<Backend["anonymous"]>, revealMs: number) {
  const queries = mount(client).queries; // a throwaway mount gives a query client; the page is rendered below
  document.body.innerHTML = "";
  return {
    queries,
    ...render(
      <Providers client={client} queries={queries}>
        <AuthGate>
          <OrgProvider>
            <RequireOrg>{(org) => <VariablesPage orgId={org.id} revealMs={revealMs} />}</RequireOrg>
          </OrgProvider>
        </AuthGate>
      </Providers>,
    ),
  };
}

describe("before there is anything to show", () => {
  test("a project is needed first, and the page says where to get one", async () => {
    const org = await backend.organization();
    const { client } = await backend.signIn("Loner", {
      orgRoles: { [org.id]: "admin" },
      projectRoles: {},
    });
    mount(client);
    const note = await screen.findByText(/No projects yet/);
    expect(within(note).getByRole("link", { name: "Import one" }).getAttribute("href")).toBe(
      "#/projects",
    );
  });

  test("a project with no environments says so, and an environment can be added", async () => {
    const s = await scene({ environments: [] });
    mount(s.client);
    await screen.findByText(/no environments yet/);
    expect(screen.queryByRole("button", { name: "Add New" })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add environment" }));
    const form = await screen.findByRole("form", { name: "Add an environment" });
    const add = within(form).getByRole("button", { name: "Add environment" });
    await user.type(within(form).getByLabelText("New environment"), "!!!");
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await user.clear(within(form).getByLabelText("New environment"));
    await user.type(within(form).getByLabelText("New environment"), "Pre Production");
    await user.click(add);
    // the first environment brings the menu, and the page opens on its list (one environment is never a matrix)
    await screen.findByText("No variables in Pre Production yet.");
    const listed = must(await s.scope.environments.get({ query: { limit: 100 } })).items;
    expect(listed.map((e) => [e.name, e.slug])).toEqual([["Pre Production", "pre-production"]]);
  });

  test("an environment the API refuses says why", async () => {
    const s = await scene({ environments: ["dev"] });
    mount(s.client);
    const user = userEvent.setup();
    await addEnvironment(user, "Dev");
    expect((await screen.findByRole("alert")).textContent).toMatch(/slug/i);
  });

  test("a project with environments and no variables says so", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    await screen.findByText(/No variables yet/);
    expect(screen.getByRole("button", { name: "Add New" })).toBeTruthy();
  });
});

describe("where each value comes from", () => {
  test("shows a value as passed down, overridden or set in one environment, and what is not set", async () => {
    const s = await scene();
    await s.put.org("REGION", "eu");
    await s.put.org("LEVEL", "from-org");
    await s.put.project("LEVEL", "from-project");
    await s.put.project("COLOR", "blue");
    await s.put.env("staging", "COLOR", "green");
    await s.put.env("staging", "ONLY_STAGING", "yes");
    mount(s.client);
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });

    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "Variable",
      "dev",
      "staging",
    ]);
    expect(screen.getAllByRole("rowheader").map((h) => h.textContent)).toEqual([
      "COLOR",
      "LEVEL",
      "ONLY_STAGING",
      "REGION",
    ]);
    expect(tagsOf(cellOf("REGION", "dev"))).toEqual(["From organization"]);
    expect(cellOf("REGION", "dev").textContent).toContain("eu");
    expect(tagsOf(cellOf("LEVEL", "dev"))).toEqual(["From project, overrides organization"]);
    expect(cellOf("LEVEL", "dev").textContent).toContain("from-project");
    expect(tagsOf(cellOf("COLOR", "dev"))).toEqual(["From project"]);
    expect(tagsOf(cellOf("COLOR", "staging"))).toEqual(["Overrides project"]);
    expect(cellOf("COLOR", "staging").textContent).toContain("green");
    expect(tagsOf(cellOf("ONLY_STAGING", "staging"))).toEqual(["Set here"]);
    expect(cellOf("ONLY_STAGING", "dev").textContent).toContain("Not set");
    expect(
      within(cellOf("ONLY_STAGING", "dev")).getByRole("button", {
        name: "Set ONLY_STAGING in dev",
      }),
    ).toBeTruthy();
  });

  test("an environment value that overrides the organization's is marked so", async () => {
    const s = await scene();
    await s.put.org("TOKEN_URL", "https://org.example");
    await s.put.env("dev", "TOKEN_URL", "https://dev.example");
    mount(s.client);
    await showCompare();
    await screen.findByRole("table");
    expect(tagsOf(cellOf("TOKEN_URL", "dev"))).toEqual(["Overrides organization"]);
    expect(tagsOf(cellOf("TOKEN_URL", "staging"))).toEqual(["From organization"]);
  });

  test("a secret is masked and marked, and a plain value that reads a secret is too", async () => {
    const s = await scene();
    await s.put.project("DB_PASSWORD", SECRET, true);
    await s.put.project("DB_URL", `postgres://u:${ref("DB_PASSWORD")}@db/app`);
    mount(s.client);
    await showCompare();
    await screen.findByRole("table");
    const password = cellOf("DB_PASSWORD", "dev");
    expect(password.textContent).not.toContain(SECRET);
    expect(tagsOf(password)).toEqual(["From project", "secret"]);
    const url = cellOf("DB_URL", "dev");
    expect(tagsOf(url)).toEqual(["From project", "secret", "reads a secret"]);
    expect(url.textContent).not.toContain("postgres://");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("a value that cannot be filled in is said so in its place", async () => {
    const s = await scene();
    await s.put.project("BROKEN", `${ref("NOT_THERE")}/x`);
    mount(s.client);
    await showCompare();
    await screen.findByRole("table");
    expect(cellOf("BROKEN", "dev").textContent).toContain("refers to a variable that is not set");
    expect(cellOf("BROKEN", "staging").textContent).toContain("refers to a variable");
  });

  test.each(["project", "organization"] as const)(
    "the markers wait for the %s's list of its own values, instead of showing and then changing",
    async (which) => {
      const s = await scene();
      await s.put.project("LEVEL", "from-project");
      await s.put.env("dev", "LEVEL", "from-dev");
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let seen: () => void = () => undefined;
      const asked = new Promise<void>((resolve) => {
        seen = resolve;
      });
      const client = clientVia(backend.api, s.cookie, async (request, send) => {
        const path = pathOf(request);
        if (
          request.method === "GET" &&
          path.endsWith("/variables") &&
          path.includes("/projects/") === (which === "project")
        ) {
          seen();
          await gate;
        }
        return send();
      });
      mount(client);
      await showCompare();
      await asked;
      // the sets themselves are quick: give them time to arrive, and the table must still not be there
      await Bun.sleep(400);
      expect(screen.queryByText(/Loading variables/) === null).toBe(false);
      expect(screen.queryByRole("table") === null).toBe(true);
      open();
      await screen.findByRole("table");
      expect(tagsOf(cellOf("LEVEL", "dev"))).toEqual(["Overrides project"]);
    },
  );

  test("a value changed at the organization shows in another project's screen too, not its cached copy", async () => {
    const s = await scene();
    const other = await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/api" });
    must(
      await s.client
        .organizations({ orgId: s.org.id })
        .projects({ projectId: other.id })
        .environments.post({ name: "prod", slug: "prod" }),
    );
    // a second one: a single environment is a list, and these tests are about the matrix
    must(
      await s.client
        .organizations({ orgId: s.org.id })
        .projects({ projectId: other.id })
        .environments.post({ name: "qa", slug: "qa" }),
    );
    await s.put.org("REGION", "eu");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await user.selectOptions(screen.getByLabelText("Project"), "acme/api");
    await waitFor(() => expect(cellOf("REGION", "prod").textContent).toContain("eu"));
    await user.selectOptions(screen.getByLabelText("Project"), "acme/web");
    await screen.findByRole("columnheader", { name: "dev" });
    await editOf(user, "REGION", "dev");
    const box = screen.getByLabelText("New value");
    await user.clear(box);
    await user.type(box, "us");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Edit REGION" }) === null).toBe(true),
    );
    await user.selectOptions(screen.getByLabelText("Project"), "acme/api");
    await waitFor(() => expect(cellOf("REGION", "prod").textContent).toContain("us"));
  });

  test("the project can be chosen when there are several", async () => {
    const s = await scene();
    const other = await createProject(backend.t.db, {
      organizationId: s.org.id,
      name: "acme/api",
    });
    await s.put.project("ONLY_WEB", "1");
    must(
      await s.client
        .organizations({ orgId: s.org.id })
        .projects({ projectId: other.id })
        .environments.post({ name: "prod", slug: "prod" }),
    );
    // a second one: a single environment is a list, and these tests are about the matrix
    must(
      await s.client
        .organizations({ orgId: s.org.id })
        .projects({ projectId: other.id })
        .environments.post({ name: "qa", slug: "qa" }),
    );
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("rowheader", { name: "ONLY_WEB" });
    await user.selectOptions(screen.getByLabelText("Project"), "acme/api");
    await screen.findByText(/No variables yet/);
    expect(screen.queryByRole("rowheader", { name: "ONLY_WEB" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "dev" })).toBeNull();
  });
});

describe("switching project", () => {
  test("closes a form that was open for the other one, so nothing typed is added to the wrong project", async () => {
    const s = await scene();
    const other = await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/api" });
    must(
      await s.client
        .organizations({ orgId: s.org.id })
        .projects({ projectId: other.id })
        .environments.post({ name: "prod", slug: "prod" }),
    );
    // a second one: a single environment is a list, and these tests are about the matrix
    must(
      await s.client
        .organizations({ orgId: s.org.id })
        .projects({ projectId: other.id })
        .environments.post({ name: "qa", slug: "qa" }),
    );
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    // visit the other project first, so its sets are cached and a switch to it is instant
    await screen.findByRole("button", { name: "Add New" });
    await user.selectOptions(screen.getByLabelText("Project"), "acme/api");
    await screen.findByText(/This project has no environments yet|No variables yet/);
    await user.selectOptions(screen.getByLabelText("Project"), "acme/web");
    await addNew(user, "Add a variable");
    await user.type(screen.getByLabelText("Name"), "LEAK");
    await user.selectOptions(screen.getByLabelText("Project"), "acme/api");
    await waitFor(() => expect(screen.queryByLabelText("Name") === null).toBe(true));
    expect(screen.queryByRole("form", { name: "Add a variable" }) === null).toBe(true);
  });
});

describe("adding", () => {
  test("a secret for every environment: masked in the table, never on the page, audited without its value", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    const box = screen.getByLabelText("Value");
    expect(box.getAttribute("type")).toBe("password");
    // no autofill or spell checker keeps what is typed
    expect(box.getAttribute("autocomplete")).toBe("off");
    expect(box.getAttribute("spellcheck")).toBe("false");
    await user.type(screen.getByLabelText("Name"), "API_KEY");
    await user.type(screen.getByLabelText("Value"), SECRET);
    await user.type(screen.getByLabelText("What it is for (optional)"), "The partner API");
    await user.click(screen.getByRole("button", { name: "Add variable" }));

    await screen.findByRole("rowheader", { name: "API_KEY" });
    expect(screen.queryByLabelText("Value")).toBeNull();
    expect(tagsOf(cellOf("API_KEY", "dev"))).toEqual(["From project", "secret"]);
    expect(tagsOf(cellOf("API_KEY", "staging"))).toEqual(["From project", "secret"]);
    expect(document.body.textContent).not.toContain(SECRET);
    const stored = must(await s.scope.variables.get({ query: { limit: 100 } })).items;
    expect(stored.map((v) => [v.key, v.kind, v.value, v.description])).toEqual([
      ["API_KEY", "secret", null, "The partner API"],
    ]);
    const audit = await s.audit("variable.create");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });

  test("a plain value for one environment is shown, and only that environment has it", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    await user.selectOptions(screen.getByLabelText("Kind"), "plain");
    expect(screen.getByLabelText("Value").tagName).toBe("TEXTAREA");
    await user.type(screen.getByLabelText("Name"), "LOG_LEVEL");
    await user.type(screen.getByLabelText("Value"), "debug");
    await user.selectOptions(screen.getByLabelText("Applies to"), "Only staging");
    await user.click(screen.getByRole("button", { name: "Add variable" }));

    await screen.findByRole("rowheader", { name: "LOG_LEVEL" });
    expect(cellOf("LOG_LEVEL", "staging").textContent).toContain("debug");
    expect(tagsOf(cellOf("LOG_LEVEL", "staging"))).toEqual(["Set here"]);
    expect(cellOf("LOG_LEVEL", "dev").textContent).toContain("Not set");
  });

  test("a plain value may be empty and shows as empty, a masked one may not be", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    expect((screen.getByLabelText("Value") as HTMLInputElement).required).toBe(true);
    await user.selectOptions(screen.getByLabelText("Kind"), "file");
    expect((screen.getByLabelText("Value") as HTMLTextAreaElement).required).toBe(true);
    await user.selectOptions(screen.getByLabelText("Kind"), "plain");
    expect((screen.getByLabelText("Value") as HTMLTextAreaElement).required).toBe(false);
    await user.type(screen.getByLabelText("Name"), "EMPTY_FLAG");
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    await screen.findByRole("rowheader", { name: "EMPTY_FLAG" });
    expect(cellOf("EMPTY_FLAG", "dev").textContent).toContain("(empty)");
    const stored = must(await s.scope.variables.get({ query: { limit: 100 } })).items;
    expect(stored.map((v) => [v.key, v.value])).toEqual([["EMPTY_FLAG", ""]]);
  });

  test("for the whole organization, and the API's refusal of a name or a repeat is shown", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    await user.type(screen.getByLabelText("Name"), "SHARED");
    await user.type(screen.getByLabelText("Value"), "one");
    await user.selectOptions(
      screen.getByLabelText("Applies to"),
      "Every project of the organization",
    );
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    await screen.findByRole("rowheader", { name: "SHARED" });
    expect(tagsOf(cellOf("SHARED", "dev"))).toEqual(["From organization", "secret"]);

    await addNew(user, "Add a variable");
    await user.type(screen.getByLabelText("Name"), "SHARED");
    await user.type(screen.getByLabelText("Value"), "two");
    await user.selectOptions(
      screen.getByLabelText("Applies to"),
      "Every project of the organization",
    );
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already/i);
    expect(alert.textContent).not.toContain("two");
    // the form stays, so the value can be corrected
    expect(screen.getByRole("form", { name: "Add a variable" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Add a variable" })).toBeNull();
  });

  test("a reporter who may not write sees the API's refusal, and nothing is created", async () => {
    const s = await scene({ reporter: true });
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    await user.type(screen.getByLabelText("Name"), "NOPE");
    await user.type(screen.getByLabelText("Value"), "x");
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/permission|allowed|forbidden/i);
    expect(await s.audit("variable.create")).toHaveLength(0);
  });

  test("overriding a passed-down value starts the form with its name and environment", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await fromMenu(user, "REGION", "staging", "Add override");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("REGION");
    expect(
      (screen.getByLabelText("Applies to") as HTMLSelectElement).selectedOptions[0]?.text,
    ).toBe("Only staging");
    await user.selectOptions(screen.getByLabelText("Kind"), "plain");
    await user.type(screen.getByLabelText("Value"), "us");
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(tagsOf(cellOf("REGION", "staging"))).toEqual(["Overrides project"]));
    expect(cellOf("REGION", "staging").textContent).toContain("us");
    expect(tagsOf(cellOf("REGION", "dev"))).toEqual(["From project"]);
    expect(cellOf("REGION", "dev").textContent).toContain("eu");
  });

  test("a value added for the project marks an environment's own value of that name as an override", async () => {
    const s = await scene();
    await s.put.env("dev", "LEVEL", "from-dev");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    expect(tagsOf(cellOf("LEVEL", "dev"))).toEqual(["Set here"]);
    await addNew(user, "Add a variable");
    await user.type(screen.getByLabelText("Name"), "LEVEL");
    await user.selectOptions(screen.getByLabelText("Kind"), "plain");
    await user.type(screen.getByLabelText("Value"), "from-project");
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(tagsOf(cellOf("LEVEL", "dev"))).toEqual(["Overrides project"]));
    expect(tagsOf(cellOf("LEVEL", "staging"))).toEqual(["From project"]);
  });

  test("setting a value where there is none uses the row's name", async () => {
    const s = await scene();
    await s.put.env("staging", "ONLY_STAGING", "yes");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await user.click(
      within(cellOf("ONLY_STAGING", "dev")).getByRole("button", {
        name: "Set ONLY_STAGING in dev",
      }),
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("ONLY_STAGING");
    expect(
      (screen.getByLabelText("Applies to") as HTMLSelectElement).selectedOptions[0]?.text,
    ).toBe("Only dev");
  });
});

describe("a typed secret", () => {
  test("is cleared once it is added, while the screen is still refreshing", async () => {
    const s = await scene();
    const page = holding(s.cookie);
    mount(page.client);
    await showCompare();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    await user.type(screen.getByLabelText("Name"), "API_KEY");
    await user.type(screen.getByLabelText("Value"), SECRET);
    page.hold();
    await user.click(screen.getByRole("button", { name: "Add variable" }));
    await waitFor(async () => expect((await s.audit("variable.create")).length).toBe(1));
    expect((screen.getByLabelText("Value") as HTMLInputElement).value).toBe("");
    page.release();
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Add a variable" }) === null).toBe(true),
    );
  });

  test("is cleared once it is saved, while the screen is still refreshing", async () => {
    const s = await scene();
    await s.put.project("API_KEY", "old-value", true);
    const page = holding(s.cookie);
    mount(page.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await editOf(user, "API_KEY", "dev");
    await user.type(screen.getByLabelText("New value"), SECRET);
    page.hold();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await s.audit("variable.update")).length).toBe(1));
    expect((screen.getByLabelText("New value") as HTMLInputElement).value).toBe("");
    page.release();
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Edit API_KEY" }) === null).toBe(true),
    );
  });
});

describe("changing", () => {
  test("a plain value starts from what it is, and the new one shows", async () => {
    const s = await scene();
    await s.put.env("dev", "LOG_LEVEL", "info");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await editOf(user, "LOG_LEVEL", "dev");
    const box = screen.getByLabelText("New value") as HTMLTextAreaElement;
    expect(box.value).toBe("info");
    expect(screen.queryByText("The current value is not shown here.") === null).toBe(true);
    await user.clear(box);
    await user.type(box, "debug");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(cellOf("LOG_LEVEL", "dev").textContent).toContain("debug"));
    expect(screen.queryByRole("form", { name: "Edit LOG_LEVEL" })).toBeNull();
    expect(await s.audit("variable.update")).toHaveLength(1);
  });

  test("a secret starts empty, says its value is not shown, and the new one is the one revealed", async () => {
    const s = await scene();
    await s.put.project("API_KEY", SECRET, true);
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await editOf(user, "API_KEY", "dev");
    const box = screen.getByLabelText("New value") as HTMLInputElement;
    expect(box.type).toBe("password");
    expect(box.value).toBe("");
    expect(screen.getByText("The current value is not shown here.")).toBeTruthy();
    await user.type(box, "replacement-77");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // a boolean: bun prints a failed DOM node whole, which takes seconds and ends the test on its timeout
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Edit API_KEY" }) === null).toBe(true),
    );
    const dialog = await detailsOf(user, "API_KEY", "dev");
    await user.click(await within(dialog).findByRole("button", { name: "Reveal API_KEY in dev" }));
    await within(dialog).findByText("replacement-77");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("editing a passed-down value says it changes it everywhere, and cancel changes nothing", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await editOf(user, "REGION", "staging");
    expect(screen.getByText(/belongs to the project/).textContent).toContain("everywhere");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Edit REGION" })).toBeNull();
    expect(await s.audit("variable.update")).toHaveLength(0);
  });

  test("a refused change says why and keeps the form", async () => {
    const s = await scene({ reporter: true });
    await s.put.env("dev", "LOG_LEVEL", "info");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await editOf(user, "LOG_LEVEL", "dev");
    await user.type(screen.getByLabelText("New value"), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/permission|allowed|forbidden/i);
    expect(screen.getByRole("form", { name: "Edit LOG_LEVEL" })).toBeTruthy();
  });
});

describe("revealing a secret", () => {
  /** What a variable's details show once asked for: Reveal is a button of the details, not of the line. */
  const reveal = async (user: ReturnType<typeof userEvent.setup>, key: string, env = "dev") => {
    const dialog = await detailsOf(user, key, env);
    await user.click(
      await within(dialog).findByRole("button", { name: `Reveal ${key} in ${env}` }),
    );
    return dialog;
  };

  test("is masked until asked for, shows the value, is audited, hides again, and is never cached", async () => {
    const s = await scene();
    await s.put.project("API_KEY", SECRET, true);
    const { queries } = mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const cell = cellOf("API_KEY", "dev");
    expect(cell.textContent).not.toContain(SECRET);
    expect(await s.audit("variable.reveal")).toHaveLength(0);

    const dialog = await reveal(user, "API_KEY");
    await within(dialog).findByText(SECRET);
    expect(within(dialog).getByRole("button", { name: "Hide API_KEY in dev" })).toBeTruthy();
    const audit = await s.audit("variable.reveal");
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    // the line behind and the other environment's copy stay masked: each reveal is its own request and its own audit row
    expect(cell.textContent).not.toContain(SECRET);
    expect(cellOf("API_KEY", "staging").textContent).not.toContain(SECRET);
    // the value lives in the details only
    const held = JSON.stringify([
      queries
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      queries
        .getMutationCache()
        .getAll()
        .map((m) => [m.state.variables, m.state.data]),
    ]);
    expect(held).not.toContain(SECRET);

    await user.click(within(dialog).getByRole("button", { name: "Hide API_KEY in dev" }));
    expect(document.body.textContent).not.toContain(SECRET);
    expect(within(dialog).getByRole("button", { name: "Reveal API_KEY in dev" })).toBeTruthy();
  });

  test("a secret from the organization, the project or one environment each reveals from its own level", async () => {
    const s = await scene();
    await s.put.org("FROM_ORG", "org-secret-1", true);
    await s.put.project("FROM_PROJECT", "project-secret-2", true);
    await s.put.env("dev", "FROM_ENV", "env-secret-3", true);
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    for (const [key, value] of [
      ["FROM_ORG", "org-secret-1"],
      ["FROM_PROJECT", "project-secret-2"],
      ["FROM_ENV", "env-secret-3"],
    ] as const) {
      const dialog = await reveal(user, key);
      await within(dialog).findByText(value);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    }
    expect(await s.audit("variable.reveal")).toHaveLength(3);
  });

  test("a secret that was changed is masked again, not left showing the old value", async () => {
    const s = await scene();
    await s.put.project("API_KEY", SECRET, true);
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const dialog = await reveal(user, "API_KEY");
    await within(dialog).findByText(SECRET);
    await user.click(within(dialog).getByRole("button", { name: "Edit API_KEY in dev" }));
    await user.type(screen.getByLabelText("New value"), "replacement-77");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Edit API_KEY" }) === null).toBe(true),
    );
    expect(document.body.textContent?.includes(SECRET)).toBe(false);
    expect(
      await within(dialog).findByRole("button", { name: "Reveal API_KEY in dev" }),
    ).toBeTruthy();
  });

  test("hides itself after a while", async () => {
    const s = await scene();
    await s.put.project("API_KEY", SECRET, true);
    mountPage(s.client, 300);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const dialog = await reveal(user, "API_KEY");
    await within(dialog).findByText(SECRET);
    await waitFor(() => expect(document.body.textContent).not.toContain(SECRET), { timeout: 3000 });
    expect(within(dialog).getByRole("button", { name: "Reveal API_KEY in dev" })).toBeTruthy();
  });

  test("a file's value can be revealed too, and a plain value needs no reveal", async () => {
    const s = await scene();
    await s.scope.variables.post({ key: "CERT", kind: "file", value: "line one\nline two" });
    await s.put.project("PLAIN", "visible");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const plain = await detailsOf(user, "PLAIN", "dev");
    await within(plain).findByText("Version");
    expect(within(plain).queryByRole("button", { name: /Reveal/ })).toBeNull();
    await user.keyboard("{Escape}");
    expect(tagsOf(cellOf("CERT", "dev"))).toEqual(["From project", "file"]);
    const dialog = await reveal(user, "CERT");
    const shown = await within(dialog).findByText(/line one/);
    expect(shown.textContent).toBe("line one\nline two");
  });

  test("without the right to reveal the API's refusal is shown and the value stays hidden", async () => {
    const s = await scene({ reporter: true });
    await s.put.project("API_KEY", SECRET, true);
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const dialog = await reveal(user, "API_KEY");
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(
      /permission|allowed|forbidden/i,
    );
    expect(document.body.textContent).not.toContain(SECRET);
    expect(await s.audit("variable.reveal")).toHaveLength(0);
    // and the reveal can be tried again
    expect(
      (within(dialog).getByRole("button", { name: "Reveal API_KEY in dev" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("deleting", () => {
  test("asks first, and cancelling deletes nothing", async () => {
    const s = await scene();
    await s.put.env("dev", "LOG_LEVEL", "info");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await fromMenu(user, "LOG_LEVEL", "dev", "Delete");
    const form = screen.getByRole("form", { name: "Delete LOG_LEVEL" });
    expect(form.textContent).toContain("Delete LOG_LEVEL from this environment?");
    expect(form.textContent).not.toContain("Every environment that gets it");
    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Delete LOG_LEVEL" })).toBeNull();
    expect(cellOf("LOG_LEVEL", "dev").textContent).toContain("info");
    expect(await s.audit("variable.delete")).toHaveLength(0);
  });

  test("confirming deletes it, audited, and the row goes", async () => {
    const s = await scene();
    await s.put.env("dev", "LOG_LEVEL", "info");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await fromMenu(user, "LOG_LEVEL", "dev", "Delete");
    await user.click(screen.getByRole("button", { name: "Delete variable" }));
    await screen.findByText(/No variables yet/);
    expect(await s.audit("variable.delete")).toHaveLength(1);
    expect(
      must(
        await s.scope
          .environments({ envId: s.envs.dev ?? "" })
          .variables.get({ query: { limit: 100 } }),
      ).items,
    ).toEqual([]);
  });

  test("a passed-down value warns that every environment loses it, and they all do", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await fromMenu(user, "REGION", "staging", "Delete");
    const form = screen.getByRole("form", { name: "Delete REGION" });
    expect(form.textContent).toContain("Delete REGION from the project?");
    expect(form.textContent).toContain("Every environment that gets it from there loses it too.");
    await user.click(within(form).getByRole("button", { name: "Delete variable" }));
    await screen.findByText(/No variables yet/);
    expect(must(await s.scope.variables.get({ query: { limit: 100 } })).items).toEqual([]);
  });

  test("a refused delete says why and keeps the variable", async () => {
    const s = await scene({ reporter: true });
    await s.put.env("dev", "LOG_LEVEL", "info");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await fromMenu(user, "LOG_LEVEL", "dev", "Delete");
    await user.click(screen.getByRole("button", { name: "Delete variable" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/permission|allowed|forbidden/i);
    expect(cellOf("LOG_LEVEL", "dev").textContent).toContain("info");
  });
});

describe("when the server fails", () => {
  test("a set that cannot be read is an error with a retry that works", async () => {
    const s = await scene();
    await s.put.project("A_KEY", "1");
    let broken = true;
    const client = clientVia(backend.api, s.cookie, async (request, send) =>
      broken && pathOf(request).endsWith("/resolved-variables") ? down("Down.") : send(),
    );
    mount(client);
    await showCompare();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Down.");
    broken = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    await screen.findByRole("rowheader", { name: "A_KEY" });
  });

  test("environments that cannot be listed are an error too", async () => {
    const s = await scene();
    const client = clientVia(backend.api, s.cookie, async (request, send) =>
      pathOf(request).endsWith("/environments") && request.method === "GET"
        ? down("No environments.")
        : send(),
    );
    mount(client);
    expect((await screen.findByRole("alert")).textContent).toContain("No environments.");
  });

  test("a failed reveal says so in the details", async () => {
    const s = await scene();
    await s.put.project("API_KEY", SECRET, true);
    const client = clientVia(backend.api, s.cookie, async (request, send) =>
      pathOf(request).endsWith("/value") ? down("Cannot open it.") : send(),
    );
    mount(client);
    await showCompare();
    await screen.findByRole("table");
    const user = userEvent.setup();
    const dialog = await detailsOf(user, "API_KEY", "dev");
    await user.click(await within(dialog).findByRole("button", { name: /Reveal/ }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Cannot open it.");
  });
});

describe("the page in the app", () => {
  test("is in the navigation, marked as the current page", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const link = await screen.findByRole("link", { name: "Variables" });
    expect(link.getAttribute("href")).toBe("#/variables");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("heading", { name: "Variables", level: 1 })).toBeTruthy();
  });
});
