import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import { addNew, cellOf, openSecrets, scene as sceneOn, showCompare } from "./variables.fixture";

// VUI-6: a row's details, and the panels its actions open (edit, tags, history, rotation, delete), are in a drawer over
// the page, not beside the list. VUI-7: so are the forms to add a variable and to import some.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = () => sceneOn(backend);
const drawer = () => screen.getByRole("dialog");

describe("details", () => {
  test("a row's name opens its details in a dialog named for it and its environment; the list stays where it is", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    const { container } = mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(within(table).getByRole("button", { name: "COLOR" }));
    const dialog = await screen.findByRole("dialog", { name: "COLOR in dev" });
    expect(within(dialog).getByRole("region", { name: "COLOR" })).toBeTruthy();
    // the list is not squeezed to make room: there is no split of the page
    expect(document.querySelector(".split")).toBeNull();
    expect(screen.getByRole("table", { name: "Variables in dev" })).toBeTruthy();
    // it is a drawer on the body, outside the page's own tree
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("The X in its header, and Esc, close it and give the page back; focus returns to the name that was pressed", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    const name = within(table).getByRole("button", { name: "COLOR" });
    await user.click(name);
    await within(await screen.findByRole("region", { name: "COLOR" })).findByText("Version");
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(name);

    await user.click(name);
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement).toBe(name);
  });

  test("History from the details opens in the same dialog, under them, and one dialog is all there is", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "COLOR" }));
    const region = await screen.findByRole("region", { name: "COLOR" });
    await within(region).findByText("Version");
    await user.click(within(region).getByRole("button", { name: "History of COLOR in dev" }));
    const history = await screen.findByRole("region", { name: "History of COLOR" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(drawer().contains(history)).toBe(true);
    expect(drawer().contains(region)).toBe(true);
    // Esc closes the whole drawer, not only the part that was opened last
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: "History of COLOR" })).toBeNull();
  });
});

describe("a row's actions", () => {
  test("Edit opens its form in the dialog; Cancel closes the drawer and focus is back on Edit", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    const edit = screen.getByRole("button", { name: "Edit COLOR" });
    await user.click(edit);
    const dialog = await screen.findByRole("dialog", { name: "COLOR in dev" });
    expect(within(dialog).getByRole("form", { name: "Edit COLOR" })).toBeTruthy();
    expect(document.querySelector(".split")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(edit);
  });

  test("Version history from the ⋯ menu opens in the dialog, and Esc puts focus back on the ⋯ button", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    const more = screen.getByRole("button", { name: "More actions for COLOR" });
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "Version history" }));
    const dialog = await screen.findByRole("dialog", { name: "COLOR in dev" });
    expect(await within(dialog).findByRole("region", { name: "History of COLOR" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more);
  });

  test("Delete, Rotation and Add tags open in the dialog too", async () => {
    const s = await scene();
    await s.put.env("dev", "TOKEN", "t0ken", true);
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    for (const [item, form] of [
      ["Delete", "Delete TOKEN"],
      ["Rotation", "Rotation of TOKEN"],
      ["Add tags", "Describe and tag TOKEN"],
    ] as const) {
      await user.click(screen.getByRole("button", { name: "More actions for TOKEN" }));
      await user.click(screen.getByRole("menuitem", { name: item }));
      const dialog = await screen.findByRole("dialog", { name: "TOKEN in dev" });
      await within(dialog).findByLabelText(form, { selector: "form, section" });
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
    }
  });

  test("Add a variable and Import open in a drawer too, over the page, and Esc closes each", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    for (const [button, title, form] of [
      ["Add a variable", "New variable", "Add a variable"],
      ["Import variables", "Import", "Import variables"],
    ] as const) {
      await addNew(user, button);
      const dialog = await screen.findByRole("dialog", { name: title });
      expect(within(dialog).getByRole("form", { name: form })).toBeTruthy();
      // the list is not squeezed to make room, and the page behind does not scroll
      expect(document.querySelector(".split")).toBeNull();
      expect(document.body.style.overflow).toBe("hidden");
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.body.style.overflow).toBe("");
    }
  });
});

// VUI-18: the drawer is a header (the title, a line for what is open, the one X), flat panels under it, and a form's
// actions as its footer: no second heading, no second Close, no loose row of buttons.
describe("the chrome", () => {
  const names = (root: Element) =>
    [...root.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") ?? b.textContent);
  const closes = (dialog: HTMLElement) => names(dialog).filter((n) => n?.startsWith("Close"));

  test("the details, the history and the rotation of a variable have one Close between them: the X in the header", async () => {
    const s = await scene();
    await s.put.env("dev", "TOKEN", "t0ken", true);
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "TOKEN" }));
    const dialog = await screen.findByRole("dialog", { name: "TOKEN in dev" });
    const region = await within(dialog).findByRole("region", { name: "TOKEN" });
    await within(region).findByText("Version");
    expect(closes(dialog)).toEqual(["Close drawer"]);
    await user.click(within(region).getByRole("button", { name: "History of TOKEN in dev" }));
    await within(dialog).findByRole("region", { name: "History of TOKEN" });
    expect(closes(dialog)).toEqual(["Close drawer"]);
    await user.click(within(region).getByRole("button", { name: "Rotation of TOKEN in dev" }));
    await within(dialog).findByLabelText("Rotation of TOKEN", { selector: "form, section" });
    expect(closes(dialog)).toEqual(["Close drawer"]);
  });

  test("the header says what is open: the details, then the history, then a form; the title stays the variable and its environment", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "COLOR" }));
    const dialog = await screen.findByRole("dialog", { name: "COLOR in dev" });
    const sub = () => dialog.querySelector(".drawer-head .drawer-sub")?.textContent;
    expect(sub()).toBe("Details of this variable");
    const region = await within(dialog).findByRole("region", { name: "COLOR" });
    await within(region).findByText("Version");
    await user.click(within(region).getByRole("button", { name: "History of COLOR in dev" }));
    await within(dialog).findByRole("region", { name: "History of COLOR" });
    expect(sub()).toBe("Audit its history and roll back changes");
    await user.click(within(region).getByRole("button", { name: "Edit COLOR in dev" }));
    await within(dialog).findByRole("form", { name: "Edit COLOR" });
    expect(sub()).toBe("Write a new value; the old one stays in the history");
    expect(screen.getByRole("dialog", { name: "COLOR in dev" })).toBe(dialog);
  });

  test("no heading in a drawer says again what its header says: not the details, the history, a form or the import", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "COLOR" }));
    let dialog = await screen.findByRole("dialog", { name: "COLOR in dev" });
    const region = await within(dialog).findByRole("region", { name: "COLOR" });
    await within(region).findByText("Version");
    expect(within(dialog).queryAllByRole("heading")).toEqual([]);
    await user.click(within(region).getByRole("button", { name: "History of COLOR in dev" }));
    await within(dialog).findByRole("region", { name: "History of COLOR" });
    expect(within(dialog).queryAllByRole("heading")).toEqual([]);
    await user.click(within(region).getByRole("button", { name: "Edit COLOR in dev" }));
    await within(dialog).findByRole("form", { name: "Edit COLOR" });
    expect(within(dialog).queryAllByRole("heading")).toEqual([]);
    await user.keyboard("{Escape}");
    await addNew(user, "Import variables");
    dialog = await screen.findByRole("dialog", { name: "Import" });
    await within(dialog).findByRole("form", { name: "Import variables" });
    expect(within(dialog).queryAllByRole("heading")).toEqual([]);
  });

  test("a form's actions are its footer, the last thing in it: Cancel, then the one that does it", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit COLOR" }));
    const dialog = await screen.findByRole("dialog", { name: "COLOR in dev" });
    const form = await within(dialog).findByRole("form", { name: "Edit COLOR" });
    const foot = form.querySelector(".drawer-foot") as HTMLElement;
    expect(foot).toBeTruthy();
    expect(form.lastElementChild).toBe(foot);
    expect(names(foot)).toEqual(["Cancel", "Save"]);
    expect(foot.lastElementChild?.classList.contains("primary")).toBe(true);
    await user.keyboard("{Escape}");
    // the import's too: Cancel first, Apply import last once there is a preview to apply
    await addNew(user, "Import variables");
    const importing = await screen.findByRole("form", { name: "Import variables" });
    const importFoot = importing.querySelector(".drawer-foot") as HTMLElement;
    expect(importing.lastElementChild).toBe(importFoot);
    expect(names(importFoot)[0]).toBe("Cancel");
  });

  test("the details' actions are one row, with Delete last", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "COLOR" }));
    const region = await screen.findByRole("region", { name: "COLOR" });
    await within(region).findByText("Version");
    const row = region.querySelector(".detail-actions") as HTMLElement;
    expect(row).toBeTruthy();
    expect(names(row)).toEqual([
      "Edit description and tags of COLOR in dev",
      "Edit COLOR in dev",
      "Move COLOR in dev",
      "History of COLOR in dev",
      "Delete COLOR in dev",
    ]);
    expect(row.lastElementChild?.classList.contains("danger")).toBe(true);
  });
});

describe("the matrix", () => {
  test("a line's Version history opens in the dialog, named for the variable and the environment of the line", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    await s.put.env("staging", "COLOR", "red");
    mount(s.client);
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    const user = userEvent.setup();
    await user.click(
      within(cellOf("COLOR", "staging")).getByRole("button", {
        name: "More actions for COLOR in staging",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Version history" }));
    const dialog = await screen.findByRole("dialog", { name: "COLOR in staging" });
    expect(await within(dialog).findByRole("region", { name: "History of COLOR" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("its Add New > Add a variable opens in the dialog too, and Esc closes it", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    const dialog = await screen.findByRole("dialog", { name: "New variable" });
    expect(within(dialog).getByRole("form", { name: "Add a variable" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
