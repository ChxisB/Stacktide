import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createProject } from "@orch/db";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import {
  addNew,
  envButton,
  must,
  openSecrets,
  ref,
  rowOf,
  SECRET,
  scene as sceneOn,
  showCompare,
  showEnvs,
  showSecrets,
} from "./variables.fixture";

// VWS-1: the Secrets view of the Variables page, one environment's variables as a list.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { environments?: string[] }) => sceneOn(backend, options);

// VUI-8: the environment menu has its own tests (variables.envs.test.tsx); these are the page around it
describe("the environment menu on the page", () => {
  test("the page opens on the first environment's list, and the old chips and select are gone", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    expect((await envButton()).textContent).toBe("dev");
    expect(screen.queryByRole("combobox", { name: /^Environment/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compare environments" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Secrets" })).toBeNull();
    expect(screen.queryByRole("table", { name: "Variables by environment" })).toBeNull();
  });

  test("choosing All environments shows the matrix, and an environment shows its list again", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });

    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    expect(screen.queryByRole("table", { name: "Variables in dev" })).toBeNull();
    // the button is still on screen to go back
    expect((await envButton()).textContent).toBe("All environments");

    await showSecrets("staging");
    await screen.findByRole("table", { name: "Variables in staging" });
    expect(screen.queryByRole("table", { name: "Variables by environment" })).toBeNull();
  });

  test("All environments stays when another project is chosen", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    const other = await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/api" });
    // two environments: one is a list, whatever is ticked
    for (const name of ["prod", "qa"])
      must(
        await s.client
          .organizations({ orgId: s.org.id })
          .projects({ projectId: other.id })
          .environments.post({ name, slug: name }),
      );
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByRole("table", { name: "Variables in dev" });
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    await user.selectOptions(screen.getByLabelText("Project"), "acme/api");
    // the matrix's words for a project with no variables, and not the list's ("No variables in prod yet.")
    await screen.findByText(/No variables yet/);
    expect(screen.queryByText("No variables in prod yet.")).toBeNull();
    expect((await envButton()).textContent).toBe("All environments");
    expect(screen.queryAllByRole("columnheader").length).toBe(0);
  });

  test("a project with no environment says so and offers Add environment, and has no menu", async () => {
    const s = await scene({ environments: [] });
    mount(s.client);
    await screen.findByText(/no environments yet/);
    expect(screen.getByRole("button", { name: "Add environment" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add an environment" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Environment/ })).toBeNull();
  });
});

describe("the page head", () => {
  test("the project select sits in the page's header beside its title", async () => {
    const s = await scene();
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/api" });
    mount(s.client);
    const select = await screen.findByLabelText("Project");
    const head = select.closest("header");
    expect(head?.querySelector("h1")?.textContent).toBe("Variables");
    expect(head?.contains(select)).toBe(true);
  });

  test("with one project the header names it, and no select is offered", async () => {
    const s = await scene();
    mount(s.client);
    // no variables here, so the card holds a sentence and no table
    await screen.findByRole("heading", { level: 2, name: "Variables in dev" });
    const head = screen.getByRole("heading", { level: 1, name: "Variables" }).closest("header");
    expect(within(head as HTMLElement).getByText("acme/web")).toBeTruthy();
    expect(screen.queryByLabelText("Project")).toBeNull();
  });
});

describe("one environment as a list", () => {
  test("a row for each variable the environment sees, with its value and where it comes from", async () => {
    const s = await scene();
    await s.put.org("REGION", "eu");
    await s.put.org("LEVEL", "from-org");
    await s.put.project("LEVEL", "from-project");
    await s.put.env("dev", "ONLY_DEV", "yes");
    await s.put.env("staging", "ONLY_STAGING", "no");
    mount(s.client);
    const table = await openSecrets();

    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["", "Name", "Value", "Source", "Actions"]); // the first is the select box's, an admin's
    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["LEVEL", "ONLY_DEV", "REGION"]);
    expect(rowOf(table, "REGION").map((c) => c.textContent)).toEqual([
      "eu",
      "Organization",
      "Edit",
    ]);
    expect(rowOf(table, "LEVEL").map((c) => c.textContent)).toEqual([
      "from-project",
      "Project",
      "Edit",
    ]);
    expect(rowOf(table, "ONLY_DEV").map((c) => c.textContent)).toEqual([
      "yes",
      "Environment",
      "Edit",
    ]);
    expect(within(table).queryByRole("rowheader", { name: "ONLY_STAGING" })).toBeNull();
  });

  test("a secret, a file and a value that reads a secret are the same mask, and no value is in the page", async () => {
    const s = await scene();
    await s.put.project("DB_PASSWORD", SECRET, true);
    await s.put.project("DB_URL", `postgres://u:${ref("DB_PASSWORD")}@db/app`);
    must(
      await s.scope.variables.post({ key: "TLS_KEY", kind: "file", value: "-----BEGIN-----\nx\n" }),
    );
    await s.put.project("REGION", "eu");
    mount(s.client);
    const table = await openSecrets();

    for (const key of ["DB_PASSWORD", "DB_URL", "TLS_KEY"]) {
      const [value] = rowOf(table, key);
      expect(value?.querySelector(".mask")?.getAttribute("aria-hidden")).toBe("true");
      expect(value?.querySelector(".mask")?.textContent).toBe("••••••••");
      expect(within(value as HTMLElement).getByText("Hidden value")).toBeTruthy();
    }
    expect(rowOf(table, "REGION")[0]?.querySelector(".mask")).toBeNull();
    const text = document.body.textContent ?? "";
    for (const secret of [SECRET, "postgres://", "BEGIN"]) expect(text).not.toContain(secret);
  });

  test("the Environment menu shows another environment's rows", async () => {
    const s = await scene();
    await s.put.env("dev", "ONLY_DEV", "yes");
    await s.put.env("staging", "ONLY_STAGING", "no");
    mount(s.client);
    const table = await openSecrets();
    expect(within(table).getByRole("rowheader", { name: "ONLY_DEV" })).toBeTruthy();

    // a second environment ticked is a matrix; going back to one is the list of the one left
    await showEnvs("staging");
    const other = await screen.findByRole("table", { name: "Variables in staging" });
    expect(rowOf(other, "ONLY_STAGING").map((c) => c.textContent)).toEqual([
      "no",
      "Environment",
      "Edit",
    ]);
    expect(within(other).queryByRole("rowheader", { name: "ONLY_DEV" })).toBeNull();
  });

  test("an environment with no variables says so instead of showing an empty table", async () => {
    const s = await scene();
    await s.put.env("staging", "ONLY_STAGING", "no");
    mount(s.client);
    await showSecrets();
    await screen.findByText("No variables in dev yet.");
    expect(screen.queryByRole("table", { name: "Variables in dev" })).toBeNull();
  });
});

// VWS-2: the search over the list
describe("searching the list", () => {
  const names = (table: HTMLElement) =>
    within(table)
      .getAllByRole("rowheader")
      .map((h) => h.textContent);

  test("keeps the rows whose name or plain value holds the text, whatever its case", async () => {
    const s = await scene();
    await s.put.org("REGION", "eu-west-1");
    await s.put.project("COLOR", "blue");
    await s.put.project("DB_PASSWORD", SECRET, true);
    mount(s.client);
    const table = await openSecrets();
    expect(names(table)).toEqual(["COLOR", "DB_PASSWORD", "REGION"]);

    const user = userEvent.setup();
    const search = screen.getByRole("searchbox", { name: "Search variables" });
    await user.type(search, "COL");
    expect(names(screen.getByRole("table", { name: "Variables in dev" }))).toEqual(["COLOR"]);
    await user.clear(search);
    await user.type(search, "west");
    expect(names(screen.getByRole("table", { name: "Variables in dev" }))).toEqual(["REGION"]);
    await user.clear(search);
    await user.type(search, "BLUE");
    expect(names(screen.getByRole("table", { name: "Variables in dev" }))).toEqual(["COLOR"]);
    await user.clear(search);
    expect(names(screen.getByRole("table", { name: "Variables in dev" }))).toHaveLength(3);
  });

  test("a secret's value is not searched: part of it finds nothing, and the page says so", async () => {
    const s = await scene();
    await s.put.project("DB_PASSWORD", SECRET, true);
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    await userEvent
      .setup()
      .type(screen.getByRole("searchbox", { name: "Search variables" }), "s3cr3t");
    await screen.findByText(/No variables match/);
    expect(screen.queryByRole("table", { name: "Variables in dev" })).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });
});

// VWS-3: a variable that cannot be filled in has no value to show, so its row says why
describe("a variable that does not resolve", () => {
  test("has a row with a note that names the reference, marked, and no source", async () => {
    const s = await scene();
    await s.put.project("BROKEN", `${ref("NOT_THERE")}/x`);
    await s.put.project("REGION", "eu");
    mount(s.client);
    const table = await openSecrets();

    expect(
      within(table)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["BROKEN", "REGION"]);
    const [value, source] = rowOf(table, "BROKEN");
    expect(value?.textContent).toContain("Does not resolve");
    const mark = value?.querySelector("mark");
    expect(mark?.textContent).toBe(ref("NOT_THERE"));
    expect(source?.textContent).toBe("Unknown");
    // the values that do resolve are as before
    expect(rowOf(table, "REGION").map((c) => c.textContent)).toEqual(["eu", "Project", "Edit"]);
  });

  test("a loop is a row for each key in it, and the search finds them by name", async () => {
    const s = await scene();
    await s.put.project("PING", ref("PONG"));
    await s.put.project("PONG", ref("PING"));
    await s.put.project("REGION", "eu");
    mount(s.client);
    const table = await openSecrets();
    for (const key of ["PING", "PONG"]) {
      expect(rowOf(table, key)[0]?.textContent).toContain("Does not resolve");
    }

    await userEvent
      .setup()
      .type(screen.getByRole("searchbox", { name: "Search variables" }), "pin");
    const found = screen.getByRole("table", { name: "Variables in dev" });
    expect(
      within(found)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["PING"]);
  });
});

// VUI-2: the controls above the list are one row: the environment, the search, a Filter, an icon, Add New
describe("the toolbar's controls", () => {
  test("each is found by the name it always had, in one row above the table, and Add is the primary", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const table = await openSecrets();
    const bar = screen
      .getByRole("searchbox", { name: "Search variables" })
      .closest(".toolbar") as HTMLElement;
    expect(bar).toBeTruthy();
    const inBar = (name: string) => within(bar).getByRole("button", { name });
    for (const name of ["Download .env", "Add New"]) inBar(name);
    expect(within(bar).getByRole("searchbox", { name: "Search variables" })).toBeTruthy();
    expect(inBar("Add New").className).toContain("primary");
    // before the table in the document, so a keyboard reaches the controls first
    expect(bar.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("Download .env shows its words beside its picture, the same words on hover, and the picture is not read", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    for (const name of ["Download .env"]) {
      const button = screen.getByRole("button", { name });
      expect(button.getAttribute("title")).toBe(name);
      // UXR-22 (moved): it had no text of its own, as an icon button; the board draws the word beside the picture
      expect(button.textContent).toBe(name);
      expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
  });

  test("the search shows what it is for before anything is typed", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    expect(
      screen.getByRole("searchbox", { name: "Search variables" }).getAttribute("placeholder"),
    ).toBe("Search variables");
  });

  test("the environment button has no visible label of its own: it is named with the choice, in the list and in the matrix", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    const button = await envButton();
    expect(button.getAttribute("aria-label")).toBe("Environment: dev");
    expect(button.closest("label")).toBeNull();
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    expect((await envButton()).getAttribute("aria-label")).toBe("Environment: All environments");
  });
});

// VUI-3: the strip between the toolbar and the table, the key mark of a secret, and the count at the table's foot
describe("the strip and the table's foot", () => {
  test("the strip names the project and the environment, and holds Reveal all (not the toolbar)", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const table = await openSecrets();
    const reveal = screen.getByRole("button", { name: "Reveal all" });
    const strip = reveal.closest(".strip") as HTMLElement;
    expect(strip).toBeTruthy();
    expect(reveal.closest(".toolbar")).toBeNull();
    expect(strip.textContent).toContain("acme/web");
    expect(strip.textContent).toContain("dev");
    const bar = screen
      .getByRole("searchbox", { name: "Search variables" })
      .closest(".toolbar") as HTMLElement;
    expect(bar.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // it is a button that still turns into Hide all, in the strip
    await userEvent.setup().click(reveal);
    expect(
      (await screen.findByRole("button", { name: "Hide all" })).closest(".strip"),
    ).toBeTruthy();
  });

  test("a secret's row has a key mark; a plain one and a key that does not resolve have the empty slot; the name is still the key", async () => {
    const s = await scene();
    await s.put.project("DB_PASS", SECRET, true);
    await s.put.project("REGION", "eu");
    await s.put.project("BROKEN", ref("NOWHERE"));
    mount(s.client);
    const table = await openSecrets();
    const mark = (key: string) =>
      within(table).getByRole("rowheader", { name: key }).querySelector<HTMLElement>(".key-mark");
    const secret = mark("DB_PASS");
    expect(secret?.getAttribute("title")).toBe("Secret");
    expect(secret?.getAttribute("aria-hidden")).toBe("true");
    expect(secret?.querySelector("svg")).toBeTruthy();
    // a plain row keeps the empty slot, so every name starts at the same place
    expect(mark("REGION")?.querySelector("svg")).toBeNull();
    expect(mark("REGION")?.getAttribute("title")).toBeNull();
    expect(mark("REGION")?.getAttribute("aria-hidden")).toBe("true");
    // a key that does not resolve has no name button but keeps the slot: its name starts where the others do (VUI-19)
    expect(mark("BROKEN")?.querySelector("svg")).toBeNull();
    expect(mark("BROKEN")?.getAttribute("aria-hidden")).toBe("true");
    // the mark and the name are one unit that does not break between them on a narrow screen (VUI-19)
    expect(secret?.parentElement?.classList.contains("key-name")).toBe(true);
    expect(mark("BROKEN")?.parentElement?.classList.contains("key-name")).toBe(true);
    // the heading has the slot too, so "Name" is over the names and not over the marks
    const heading = within(table).getByRole("columnheader", { name: "Name" });
    expect(heading.querySelector(".key-mark")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("the foot counts the rows: all of them, then how many of them a search or a tag leaves", async () => {
    const s = await scene();
    await s.put.project("ALPHA", "1");
    await s.put.project("BETA", "2");
    await s.scope.variables
      .post({ key: "GAMMA", kind: "plain", value: "3", tags: ["eu"] })
      .then(must);
    mount(s.client);
    const table = await openSecrets();
    const foot = () => screen.getByText(/variables?$/, { selector: "p" });
    expect(foot().textContent).toBe("3 variables");
    expect(table.compareDocumentPosition(foot()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search variables" }), "a");
    // alpha, beta and gamma all hold an "a"; a longer word leaves fewer
    expect(foot().textContent).toBe("3 of 3 variables");
    await user.type(screen.getByRole("searchbox", { name: "Search variables" }), "lp");
    expect(foot().textContent).toBe("1 of 3 variables");
    await user.clear(screen.getByRole("searchbox", { name: "Search variables" }));
    await user.selectOptions(screen.getByLabelText("Tag"), "eu");
    expect(foot().textContent).toBe("1 of 3 variables");
  });

  test("one row is '1 variable', and an environment with none, or a search with no match, has no count", async () => {
    const s = await scene();
    await s.put.project("ONLY", "1");
    mount(s.client);
    await openSecrets();
    expect(screen.getByText("1 variable", { selector: "p" })).toBeTruthy();
    await userEvent
      .setup()
      .type(screen.getByRole("searchbox", { name: "Search variables" }), "zzz");
    expect(await screen.findByText(/No variables match/)).toBeTruthy();
    expect(screen.queryByText(/variables?$/, { selector: "p" })).toBeNull();
  });
});

// VWS-5: Add and Import from the toolbar of the list (the matrix's own words and forms)
describe("the toolbar", () => {
  test("Add a variable opens the form for the environment on show, and the new row is in that list", async () => {
    const s = await scene();
    mount(s.client);
    await showSecrets();
    const user = userEvent.setup();
    await showSecrets("staging");
    await screen.findByText("No variables in staging yet.");

    await addNew(user, "Add a variable");
    const form = screen.getByRole("form", { name: "Add a variable" });
    expect(
      (within(form).getByLabelText("Applies to") as HTMLSelectElement).selectedOptions[0]?.text,
    ).toBe("Only staging");
    await user.type(within(form).getByLabelText("Name"), "NEW_FLAG");
    await user.selectOptions(within(form).getByLabelText("Kind"), "plain");
    await user.type(within(form).getByLabelText("Value"), "on");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));

    const table = await screen.findByRole("table", { name: "Variables in staging" });
    expect(rowOf(table, "NEW_FLAG").map((c) => c.textContent)).toEqual([
      "on",
      "Environment",
      "Edit",
    ]);
    expect(screen.queryByRole("form", { name: "Add a variable" })).toBeNull();
  });

  test("Import variables opens the import form, and Cancel closes it", async () => {
    const s = await scene();
    mount(s.client);
    await showSecrets();
    const user = userEvent.setup();
    await addNew(user, "Import variables");
    const form = screen.getByRole("form", { name: "Import variables" });
    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Import variables" })).toBeNull();
  });

  test("a form and a row's details can be open together, and a change of environment closes both", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "REGION" }));
    await screen.findByRole("region", { name: "REGION" });
    await addNew(user, "Add a variable");
    expect(screen.getByRole("form", { name: "Add a variable" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "REGION" })).toBeTruthy();

    await showSecrets("staging");
    expect(screen.queryByRole("form", { name: "Add a variable" })).toBeNull();
    expect(screen.queryByRole("region", { name: "REGION" })).toBeNull();
  });
});
