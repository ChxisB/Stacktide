import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import { openSecrets, scene as sceneOn } from "./variables.fixture";

// VUI-13: the list's Add a variable button and Import icon are one Add New menu with the two as its items.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

/** A scene with one variable already in it: an empty environment shows no table to wait for. */
const scene = async () => {
  const s = await sceneOn(backend);
  await s.put.project("STARTER", "1");
  return s;
};
const addNew = () => screen.getByRole("button", { name: "Add New" });
const items = () => screen.getAllByRole("menuitem").map((i) => i.textContent);

describe("the list's toolbar", () => {
  test("has one Add New button, and neither action is on the page until it is open", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    const button = addNew();
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    // the one button that makes something, so it is the one in the action colour
    expect(button.className).toContain("primary");
    expect(screen.queryByRole("button", { name: "Add a variable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import variables" })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    // Download .env stays beside it, on view
    expect(screen.getByRole("button", { name: "Download .env" })).toBeTruthy();
  });

  test("opens a menu named Add New with Add a variable and Import variables in it", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    await userEvent.setup().click(addNew());
    const menu = screen.getByRole("menu", { name: "Add New" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((i) => i.textContent),
    ).toEqual(["Add a variable", "Import variables"]);
    expect(addNew().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Download .env" })).toBeTruthy();
  });
});

describe("its items", () => {
  test("Add a variable opens the Create drawer for the open environment; Esc closes it and the focus is back on Add New", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(addNew());
    await user.click(screen.getByRole("menuitem", { name: "Add a variable" }));
    const drawer = await screen.findByRole("dialog", { name: "New variable" });
    const form = within(drawer).getByRole("form", { name: "Add a variable" });
    expect((within(form).getByLabelText("Applies to") as HTMLSelectElement).value).toBe(
      s.envs.dev as string,
    );
    // choosing closed the menu
    expect(screen.queryByRole("menu")).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(document.activeElement).toBe(addNew());
  });

  test("Import variables opens the import form in its own dialog", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(addNew());
    await user.click(screen.getByRole("menuitem", { name: "Import variables" }));
    const drawer = await screen.findByRole("dialog", { name: "Import" });
    expect(within(drawer).getByRole("form", { name: "Import variables" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the keyboard", () => {
  test("Arrow Down on the closed button opens it with the first item focused; the arrows, Home and End move; Esc closes it with the focus back on the button", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    addNew().focus();
    await user.keyboard("{ArrowDown}");
    expect(items()).toEqual(["Add a variable", "Import variables"]);
    const at = () => (document.activeElement as HTMLElement).textContent;
    expect(at()).toBe("Add a variable");
    await user.keyboard("{ArrowDown}");
    expect(at()).toBe("Import variables");
    // past the end it goes round
    await user.keyboard("{ArrowDown}");
    expect(at()).toBe("Add a variable");
    await user.keyboard("{ArrowUp}");
    expect(at()).toBe("Import variables");
    await user.keyboard("{Home}");
    expect(at()).toBe("Add a variable");
    await user.keyboard("{End}");
    expect(at()).toBe("Import variables");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(addNew());
  });

  test("Enter on a focused item chooses it", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    addNew().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await screen.findByRole("dialog", { name: "Import" });
  });
});
