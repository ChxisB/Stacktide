import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import {
  cellOf,
  detailsOf,
  openEnvs,
  SECRET,
  scene as sceneOn,
  showCompare,
} from "./variables.fixture";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

describe("the variables screen's layout", () => {
  test("the grid is in a card, and the environment form is in a dialog over the page", async () => {
    const s = await sceneOn(backend);
    await s.put.project("REGION", "eu", false);
    mount(s.client);
    await showCompare();
    const grid = await screen.findByRole("region", { name: "Variables by environment" });
    expect(within(grid).getByRole("table", { name: "Variables by environment" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Add an environment" })).toBeNull();
    const user = userEvent.setup();
    await user.click(within(await openEnvs(user)).getByRole("button", { name: "Add environment" }));
    const form = await screen.findByRole("form", { name: "Add an environment" });
    expect(form.closest(".drawer.centered")).not.toBeNull();
  });

  test("a secret is a mask on its line, and the mask is not read out; its value is shown in the details, once asked for", async () => {
    const s = await sceneOn(backend);
    await s.put.project("DB_PASSWORD", SECRET, true);
    mount(s.client);
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    const cell = cellOf("DB_PASSWORD", "dev");
    const mask = cell.querySelector(".mask");
    expect(mask?.getAttribute("aria-hidden")).toBe("true");
    expect(cell.textContent).not.toContain(SECRET);
    const user = userEvent.setup();
    const dialog = await detailsOf(user, "DB_PASSWORD", "dev");
    await user.click(
      await within(dialog).findByRole("button", { name: "Reveal DB_PASSWORD in dev" }),
    );
    expect((await within(dialog).findByText(SECRET)).className).toBe("revealed");
    // the line behind the drawer keeps its mask: the value is in the drawer and nowhere else
    expect(cell.querySelector(".mask")).not.toBeNull();
    expect(cell.textContent).not.toContain(SECRET);
  });
});
