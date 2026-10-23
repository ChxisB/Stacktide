import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { Icon } from "./components";
import { type Backend, clientVia, mount, pathOf, startBackend } from "./testing";
import {
  cellOf,
  detailsOf,
  markOf,
  ref,
  rowList,
  SECRET,
  scene as sceneOn,
  showCompare,
  tagsOf,
  withClipboard,
} from "./variables.fixture";

// VUI-9: All environments as a matrix of marks: a green tick where the environment has the variable, a yellow circle
// where it has not. The key opens its row, one line for each environment, with the buttons of a line shown for the
// line that is pointed at. No value is in the collapsed matrix and no secret is anywhere in it.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);
const PLAIN = "api.example.test";

/** Dev and staging: a project value in both, an override in staging, a key only staging has, an organization secret, a key that does not resolve. */
async function withKeys() {
  const s = await scene();
  await s.put.project("API_URL", PLAIN);
  await s.put.project("REGION", "eu");
  await s.put.env("staging", "REGION", "us");
  await s.put.env("staging", "ONLY_STAGING", "x");
  await s.put.org("DB_PASS", SECRET, true);
  await s.put.project("BROKEN", ref("NOWHERE"));
  return s;
}
/** The matrix, once it is up. */
async function matrix() {
  await showCompare();
  return screen.findByRole("table", { name: "Variables by environment" });
}
const words = (el: HTMLElement) => el.textContent?.replace(/\s+/g, " ").trim();
const nothingOf = (value: string) => expect(document.body.textContent).not.toContain(value);

describe("the marks", () => {
  test("a cell is a tick where the environment has the variable and a circle where it has not, each with its words", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    // the words come with the mark: a screen reader and a title say what the picture does
    expect(words(markOf("API_URL", "dev"))).toBe("From project");
    expect(words(markOf("API_URL", "staging"))).toBe("From project");
    expect(words(markOf("REGION", "dev"))).toBe("From project");
    expect(words(markOf("REGION", "staging"))).toBe("Set here");
    expect(words(markOf("DB_PASS", "dev"))).toBe("From organization");
    expect(words(markOf("ONLY_STAGING", "dev"))).toBe("Not set");
    expect(words(markOf("ONLY_STAGING", "staging"))).toBe("Set here");
    expect(words(markOf("BROKEN", "dev"))).toMatch(/^Does not resolve/);
    const set = markOf("API_URL", "dev").querySelector(".cell-mark");
    const missing = markOf("ONLY_STAGING", "dev").querySelector(".cell-mark");
    expect(set?.classList.contains("set")).toBe(true);
    expect(missing?.classList.contains("missing")).toBe(true);
    expect(markOf("BROKEN", "dev").querySelector(".cell-mark")?.classList.contains("broken")).toBe(
      true,
    );
    expect(set?.getAttribute("title")).toBe("From project");
    expect(missing?.getAttribute("title")).toBe("Not set");
    // a state is never the colour alone: the two drawings differ
    const drawing = (m: Element | null | undefined) =>
      m?.querySelector("svg path")?.getAttribute("d");
    // a tick for set, a circle for not set, a cross for one that does not resolve: the pictures the screens of Infisical use
    const iconPath = (name: "tick" | "circle" | "close") =>
      renderToStaticMarkup(<Icon name={name} />).match(/ d="([^"]+)"/)?.[1];
    expect(drawing(set)).toBe(iconPath("tick"));
    expect(drawing(missing)).toBe(iconPath("circle"));
    expect(drawing(markOf("BROKEN", "dev").querySelector(".cell-mark"))).toBe(iconPath("close"));
    expect(drawing(set)).not.toBe(drawing(missing));
    // and the picture is for the eye: the words are what is read
    expect(set?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("the collapsed matrix holds no value and no button but one for each key", async () => {
    const s = await withKeys();
    mount(s.client);
    const grid = await matrix();
    const body = grid.querySelector("tbody") as HTMLElement;
    const names = within(body)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(names).toEqual(["API_URL", "BROKEN", "DB_PASS", "ONLY_STAGING", "REGION"]);
    for (const value of [PLAIN, "eu", "us", SECRET]) expect(body.textContent).not.toContain(value);
    expect(within(body).queryByRole("list")).toBeNull();
    for (const b of within(body).getAllByRole("button"))
      expect(b.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the open row", () => {
  test("a key opens its row and closes it; several rows can be open together", async () => {
    const s = await withKeys();
    mount(s.client);
    const grid = await matrix();
    const user = userEvent.setup();
    const toggle = (key: string) => within(grid).getByRole("button", { name: key });
    await user.click(toggle("API_URL"));
    expect(toggle("API_URL").getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: "API_URL by environment" });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.firstElementChild?.textContent),
    ).toEqual(["dev", "staging"]);
    await user.click(toggle("REGION"));
    expect(screen.getByRole("list", { name: "API_URL by environment" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "REGION by environment" })).toBeTruthy();
    await user.click(toggle("API_URL"));
    expect(toggle("API_URL").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "API_URL by environment" })).toBeNull();
    expect(screen.getByRole("list", { name: "REGION by environment" })).toBeTruthy();
  });

  test("a line keeps what the old cell said: the source, the kind, the value or its mask", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    expect(tagsOf(cellOf("API_URL", "dev"))).toEqual(["From project"]);
    expect(cellOf("API_URL", "dev").textContent).toContain(PLAIN);
    expect(tagsOf(cellOf("REGION", "staging"))).toEqual(["Overrides project"]);
    expect(cellOf("REGION", "staging").textContent).toContain("us");
    expect(cellOf("REGION", "dev").textContent).toContain("eu");
    // a secret is a mask, and its words, never the value
    expect(tagsOf(cellOf("DB_PASS", "dev"))).toEqual(["From organization", "secret"]);
    expect(cellOf("DB_PASS", "dev").textContent).toContain("Hidden value");
    nothingOf(SECRET);
    // a key an environment lacks says so and offers to set it; one that does not resolve says why
    const missing = cellOf("ONLY_STAGING", "dev");
    expect(missing.textContent).toContain("Not set");
    expect(within(missing).getByRole("button", { name: "Set ONLY_STAGING in dev" })).toBeTruthy();
    expect(within(missing).queryByRole("button", { name: /^(Edit|Copy|More)/ })).toBeNull();
    expect(cellOf("BROKEN", "dev").textContent).toMatch(/Does not resolve/);
  });

  test("each line that has the variable has Edit value, Copy value and a menu, named for it; they are in the page for a Tab", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    const line = cellOf("REGION", "staging");
    const buttons = within(line)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(buttons).toEqual([
      "REGION in staging",
      "Edit value of REGION in staging",
      "Copy value of REGION in staging",
      "More actions for REGION in staging",
    ]);
    expect(
      within(line)
        .getByRole("button", { name: "More actions for REGION in staging" })
        .getAttribute("aria-haspopup"),
    ).toBe("menu");
  });

  test("a line's name opens the details of that variable in that environment, and Esc gives the focus back", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    const user = userEvent.setup();
    const dialog = await detailsOf(user, "REGION", "staging");
    const region = await within(dialog).findByRole("region", { name: "REGION" });
    await within(region).findByText("Version");
    expect(region.textContent).toContain("Overrides the Project value");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(document.activeElement).toBe(
      within(cellOf("REGION", "staging")).getByRole("button", { name: "REGION in staging" }),
    );
    // the other environment's line is its own details
    const other = await detailsOf(user, "REGION", "dev");
    await within(other).findByText("Version");
    expect(other.textContent).toContain("SourceProject");
  });

  test("Set opens Create with the key and the environment filled in", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    const user = userEvent.setup();
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

describe("a line's buttons", () => {
  test("Edit value opens the edit form for that environment's value, and the row shows the new value once it is saved", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    const user = userEvent.setup();
    await user.click(
      within(cellOf("REGION", "staging")).getByRole("button", {
        name: "Edit value of REGION in staging",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "REGION in staging" });
    const form = within(dialog).getByRole("form", { name: "Edit REGION" });
    const field = within(form).getByLabelText("New value");
    await user.clear(field);
    await user.type(field, "ap");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(cellOf("REGION", "staging").textContent).toContain("ap"));
    expect(screen.queryByRole("dialog") === null).toBe(true);
    // the row is still open, and the other environment is as it was
    expect(rowList("REGION")).toBeTruthy();
    expect(cellOf("REGION", "dev").textContent).toContain("eu");
  });

  test("Copy value: a secret is read once from the audited route and goes to the clipboard, never into the page", async () => {
    const s = await withKeys();
    const reads: string[] = [];
    const client = clientVia(backend.api, s.cookie, (request, send) => {
      if (/^GET .*\/variables\/[^/]+\/value$/.test(`${request.method} ${pathOf(request)}`))
        reads.push(pathOf(request));
      return send();
    });
    mount(client);
    await matrix();
    await withClipboard("keeps", async (written, user) => {
      await user.click(
        within(cellOf("DB_PASS", "dev")).getByRole("button", {
          name: "Copy value of DB_PASS in dev",
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toBe("Copied the value of DB_PASS"),
      );
      expect(written).toEqual([SECRET]);
      expect(reads).toHaveLength(1);
      expect(await s.audit("variable.reveal")).toHaveLength(1);
      nothingOf(SECRET);
      // a plain value is already in the page: no read
      await user.click(
        within(cellOf("API_URL", "dev")).getByRole("button", {
          name: "Copy value of API_URL in dev",
        }),
      );
      await waitFor(() => expect(written).toEqual([SECRET, PLAIN]));
      expect(reads).toHaveLength(1);
    });
  });

  test("a clipboard that refuses says so in words and shows no value", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    await withClipboard("refuses", async (_written, user) => {
      await user.click(
        within(cellOf("DB_PASS", "dev")).getByRole("button", {
          name: "Copy value of DB_PASS in dev",
        }),
      );
      expect((await screen.findByRole("alert")).textContent).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
      nothingOf(SECRET);
    });
  });

  test("the menu offers what the variable allows: Rotation only for a secret, Add override only where it is passed down", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    const user = userEvent.setup();
    const items = async (key: string, env: string) => {
      await user.click(
        within(cellOf(key, env)).getByRole("button", { name: `More actions for ${key} in ${env}` }),
      );
      const names = screen.getAllByRole("menuitem").map((i) => i.textContent);
      await user.keyboard("{Escape}");
      return names;
    };
    expect(await items("REGION", "dev")).toEqual([
      "Edit details",
      "Add tags",
      "Version history",
      "Add override",
      "Copy value",
      "Delete",
    ]);
    expect(await items("REGION", "staging")).toEqual([
      "Edit details",
      "Add tags",
      "Version history",
      "Copy value",
      "Delete",
    ]);
    expect(await items("DB_PASS", "dev")).toEqual([
      "Edit details",
      "Add tags",
      "Version history",
      "Rotation",
      "Add override",
      "Copy value",
      "Delete",
    ]);
  });

  test("each menu item opens its own screen for that variable in that environment", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    const user = userEvent.setup();
    const choose = async (key: string, env: string, item: string) => {
      await user.click(
        within(cellOf(key, env)).getByRole("button", { name: `More actions for ${key} in ${env}` }),
      );
      await user.click(screen.getByRole("menuitem", { name: item }));
    };
    const close = async () => {
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    };
    await choose("REGION", "dev", "Edit details");
    expect(await screen.findByRole("region", { name: "REGION" })).toBeTruthy();
    await close();
    await choose("REGION", "dev", "Add tags");
    expect(await screen.findByRole("form", { name: "Describe and tag REGION" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "REGION in dev" })).toBeTruthy();
    await close();
    await choose("REGION", "dev", "Version history");
    expect(await screen.findByRole("region", { name: "History of REGION" })).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "REGION in dev" })).toBeTruthy();
    await close();
    await choose("DB_PASS", "dev", "Rotation");
    expect(await screen.findByRole("region", { name: "Rotation of DB_PASS" })).toBeTruthy();
    await close();
    await choose("REGION", "dev", "Add override");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("REGION");
    expect(
      (screen.getByLabelText("Applies to") as HTMLSelectElement).selectedOptions[0]?.text,
    ).toBe("Only dev");
    await close();
    await choose("REGION", "staging", "Delete");
    expect(await screen.findByRole("form", { name: "Delete REGION" })).toBeTruthy();
    expect(await s.audit("variable.delete")).toHaveLength(0);
  });

  test("every action the old cell had is reachable from the details drawer", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    const user = userEvent.setup();
    const dialog = await detailsOf(user, "DB_PASS", "dev");
    // the details read the variable first; the buttons come with what they read
    await within(dialog).findByText("Version");
    for (const name of [
      "Reveal DB_PASS in dev",
      "Edit DB_PASS in dev",
      "Override DB_PASS in dev",
      "History of DB_PASS in dev",
      "Rotation of DB_PASS in dev",
      "Delete DB_PASS in dev",
    ])
      expect(within(dialog).getByRole("button", { name })).toBeTruthy();
  });
});
