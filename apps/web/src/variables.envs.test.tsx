import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import {
  addEnvironment,
  envButton,
  must,
  openEnvs,
  scene as sceneOn,
  showCompare,
  showSecrets,
} from "./variables.fixture";

// VUI-8: the environment select is a menu of checkboxes: one ticked is the list, several or all the matrix of those.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

/** A scene with one variable already in it (an empty environment shows no table to wait for), and three environments (the API lists them by name: dev, prod, staging). */
const scene = async (environments = ["dev", "staging", "prod"]) => {
  const s = await sceneOn(backend, { environments });
  await s.put.project("STARTER", "1");
  return s;
};
const boxes = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("checkbox")
    .map((b) => [b.closest("label")?.textContent, (b as HTMLInputElement).checked]);
const box = (menu: HTMLElement, name: string) =>
  within(menu).getByRole("checkbox", { name }) as HTMLInputElement;
const columns = () => screen.getAllByRole("columnheader").map((h) => h.textContent);

describe("the button", () => {
  test("is named Environment, shows the choice, and no menu or old select is on the page until it is pressed", async () => {
    const s = await scene();
    mount(s.client);
    const button = await envButton();
    await screen.findByRole("table", { name: "Variables in dev" });
    expect(button.getAttribute("aria-label")).toBe("Environment: dev");
    expect(button.textContent).toBe("dev");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("group", { name: "Environment" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Environment" })).toBeNull();
    // the card that held the form is gone: the form comes from the menu, in a dialog
    expect(screen.queryByRole("form", { name: "Add an environment" })).toBeNull();
    expect(screen.queryByLabelText("New environment")).toBeNull();
  });

  test("opens a menu with a filter, All environments, a checkbox for each environment, Add environment and the hint", async () => {
    const s = await scene();
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    expect((await envButton()).getAttribute("aria-expanded")).toBe("true");
    expect(within(menu).getByRole("searchbox", { name: "Filter environments" })).toBeTruthy();
    expect(boxes(menu)).toEqual([
      ["All environments", false],
      ["dev", true],
      ["prod", false],
      ["staging", false],
    ]);
    expect(within(menu).getByRole("button", { name: "Add environment" }).textContent).toBe(
      "+ Add environment",
    );
    expect(
      within(menu).getByText("Use the checkboxes to select multiple environments."),
    ).toBeTruthy();
  });
});

describe("ticking", () => {
  test("another environment shows the matrix of the two, the button names both, and the menu stays open", async () => {
    const s = await scene();
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    await user.click(box(menu, "staging"));
    await screen.findByRole("table", { name: "Variables by environment" });
    expect(columns()).toEqual(["Variable", "dev", "staging"]);
    expect(screen.queryByRole("table", { name: "Variables in dev" })).toBeNull();
    const button = await envButton();
    expect(button.textContent).toBe("dev, staging");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("group", { name: "Environment" })).toBeTruthy();
  });

  test("two of three give the matrix exactly those columns, in the environments' order", async () => {
    const s = await scene();
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    await user.click(box(menu, "prod"));
    await screen.findByRole("table", { name: "Variables by environment" });
    expect(columns()).toEqual(["Variable", "dev", "prod"]);
    expect((await envButton()).textContent).toBe("dev, prod");
  });

  test("All environments shows every column and reads All environments; ticking it off leaves the first one, as a list", async () => {
    const s = await scene();
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    await user.click(box(menu, "All environments"));
    await screen.findByRole("table", { name: "Variables by environment" });
    expect(columns()).toEqual(["Variable", "dev", "prod", "staging"]);
    expect((await envButton()).textContent).toBe("All environments");
    expect(boxes(menu).map(([, on]) => on)).toEqual([true, true, true, true]);

    await user.click(box(menu, "All environments"));
    await screen.findByRole("table", { name: "Variables in dev" });
    expect((await envButton()).textContent).toBe("dev");
    expect(boxes(menu).map(([, on]) => on)).toEqual([false, true, false, false]);
  });

  test("every environment ticked one by one is All environments", async () => {
    const s = await scene(["dev", "staging"]);
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    await user.click(box(menu, "staging"));
    expect((await envButton()).textContent).toBe("All environments");
    expect(box(menu, "All environments").checked).toBe(true);
  });

  test("down to one shows the list again, and the last one ticked cannot be unticked", async () => {
    const s = await scene();
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    await user.click(box(menu, "staging"));
    await screen.findByRole("table", { name: "Variables by environment" });
    expect(box(menu, "dev").disabled).toBe(false);
    await user.click(box(menu, "dev"));
    await screen.findByRole("table", { name: "Variables in staging" });
    expect((await envButton()).textContent).toBe("staging");
    expect(box(menu, "staging").disabled).toBe(true);
    await user.click(box(menu, "staging"));
    expect(box(menu, "staging").checked).toBe(true);
    expect(screen.getByRole("table", { name: "Variables in staging" })).toBeTruthy();
  });

  test("the menu stays open, and the focus stays on the box pressed, when the page changes from the list to the matrix", async () => {
    const s = await scene();
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    const staging = box(menu, "staging");
    await user.click(staging);
    await screen.findByRole("table", { name: "Variables by environment" });
    // the same box, still in the page and still focused: a keyboard user can go on to the next
    expect(staging.isConnected).toBe(true);
    expect(document.activeElement === staging).toBe(true);
    await user.keyboard(" ");
    await screen.findByRole("table", { name: "Variables in dev" });
    expect(staging.checked).toBe(false);
  });
});

describe("the filter", () => {
  test("narrows the environments by what is typed, and All environments stays", async () => {
    const s = await scene();
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    const filter = within(menu).getByRole("searchbox", { name: "Filter environments" });
    await user.type(filter, "STAG");
    expect(boxes(menu).map(([name]) => name)).toEqual(["All environments", "staging"]);
    await user.clear(filter);
    expect(boxes(menu).map(([name]) => name)).toEqual([
      "All environments",
      "dev",
      "prod",
      "staging",
    ]);
    await user.type(filter, "zzz");
    expect(boxes(menu).map(([name]) => name)).toEqual(["All environments"]);
    expect(within(menu).getByText("No environment matches.")).toBeTruthy();
  });
});

describe("closing", () => {
  test("Esc closes the menu with the focus on the button, and so does a press outside", async () => {
    const s = await scene();
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    await openEnvs(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Environment" })).toBeNull();
    expect(document.activeElement === (await envButton())).toBe(true);

    await openEnvs(user);
    await user.click(screen.getByRole("table", { name: "Variables in dev" }));
    expect(screen.queryByRole("group", { name: "Environment" })).toBeNull();
  });
});

describe("Add environment", () => {
  test("opens a centred dialog and closes the menu; the form makes Pre Production as pre-production, and the menu lists it", async () => {
    const s = await scene(["dev", "staging"]);
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    await user.click(within(menu).getByRole("button", { name: "Add environment" }));
    const dialog = await screen.findByRole("dialog", { name: "Add environment" });
    expect(dialog.className).toContain("centered");
    expect(screen.queryByRole("group", { name: "Environment" })).toBeNull();

    const form = within(dialog).getByRole("form", { name: "Add an environment" });
    const add = within(form).getByRole("button", { name: "Add environment" }) as HTMLButtonElement;
    const name = within(form).getByLabelText("New environment");
    await user.type(name, "!!!");
    expect(add.disabled).toBe(true);
    await user.clear(name);
    await user.type(name, "Pre Production");
    await user.click(add);
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    const listed = must(await s.scope.environments.get({ query: { limit: 100 } })).items;
    expect(listed.map((e) => [e.name, e.slug])).toEqual([
      ["dev", "dev"],
      ["Pre Production", "pre-production"],
      ["staging", "staging"],
    ]);
    // the focus is back on the button, and the new environment is in the menu, not ticked
    expect(document.activeElement === (await envButton())).toBe(true);
    const again = await openEnvs(user);
    await waitFor(() =>
      expect(boxes(again).map(([n]) => n)).toEqual([
        "All environments",
        "dev",
        "Pre Production",
        "staging",
      ]),
    );
    expect(box(again, "Pre Production").checked).toBe(false);
  });

  test("an environment the API refuses says why, and the dialog stays open", async () => {
    const s = await scene(["dev"]);
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    await addEnvironment(user, "Dev");
    expect((await screen.findByRole("alert")).textContent).toMatch(/slug/i);
    expect(screen.getByRole("dialog", { name: "Add environment" })).toBeTruthy();
  });

  test("Esc closes the dialog and the focus is back on the Environment button", async () => {
    const s = await scene();
    mount(s.client);
    await screen.findByRole("table", { name: "Variables in dev" });
    const user = userEvent.setup();
    const menu = await openEnvs(user);
    await user.click(within(menu).getByRole("button", { name: "Add environment" }));
    await screen.findByRole("dialog", { name: "Add environment" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(document.activeElement === (await envButton())).toBe(true);
  });

  test("a project with no environment has no menu, and a button on the page that opens the same dialog", async () => {
    const s = await sceneOn(backend, { environments: [] });
    mount(s.client);
    await screen.findByText(/no environments yet/);
    expect(screen.queryByRole("button", { name: /^Environment/ })).toBeNull();
    await addEnvironment(userEvent.setup(), "Dev");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    // now it has one: the menu shows it, and the list is its own
    expect((await envButton()).textContent).toBe("Dev");
    await screen.findByText("No variables in Dev yet.");
  });
});

describe("the helpers the other tests use", () => {
  test("showCompare ticks everything, and showSecrets narrows to the one named", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    expect(columns()).toEqual(["Variable", "dev", "prod", "staging"]);
    await showSecrets("prod");
    await screen.findByRole("table", { name: "Variables in prod" });
    expect((await envButton()).textContent).toBe("prod");
  });
});
