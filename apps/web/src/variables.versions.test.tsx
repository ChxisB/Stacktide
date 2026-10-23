import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, mount, startBackend } from "./testing";
import { must, openSecrets, SECRET, scene as sceneOn } from "./variables.fixture";

// VUI-6: each version in the history has its value, hidden until it is asked for, and a copy: both read that version
// from the audited reveal route (one `variable.reveal` row each, with the version), and nothing else shows a value.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);
const SECOND = "second-value-22";
const THIRD = "third-value-33";

/** A secret with three versions in dev, and the page's client noting the query of every reveal. */
async function threeVersions(options?: { reporter?: boolean; plain?: boolean }) {
  const s = await scene(options);
  const v = await s.put.env("dev", "API_KEY", SECRET, !options?.plain);
  const edit = s.scope.environments({ envId: s.envs.dev ?? "" }).variables({ varId: v.id });
  must(await edit.patch({ value: SECOND }));
  must(await edit.patch({ value: THIRD }));
  const reveals: string[] = [];
  const client = clientVia(backend.api, s.cookie, (request, send) => {
    const url = new URL(request.url);
    if (request.method === "GET" && /\/variables\/[^/]+\/value$/.test(url.pathname))
      reveals.push(url.search);
    return send();
  });
  return { s, client, reveals };
}

/** The history of API_KEY, open from the row's ⋯ menu of the page `openSecrets` has opened, once its versions have loaded. */
async function history(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "More actions for API_KEY" }));
  await user.click(screen.getByRole("menuitem", { name: "Version history" }));
  const region = await screen.findByRole("region", { name: "History of API_KEY" });
  await within(region).findByRole("list", { name: "Versions of API_KEY" });
  return region;
}
/** One version of the timeline: a list item named "Version N" (VUI-15). */
const rowOf = (region: HTMLElement, version: number) =>
  within(within(region).getByRole("listitem", { name: `Version ${version}` }));
const reveals = (s: Awaited<ReturnType<typeof threeVersions>>["s"]) => s.audit("variable.reveal");

/** A clipboard that keeps what it was given, put back afterwards; the user is set up first because user-event installs one. */
async function withClipboard(
  run: (written: string[], user: ReturnType<typeof userEvent.setup>) => Promise<void>,
) {
  const user = userEvent.setup();
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        written.push(text);
      },
    },
  });
  try {
    await run(written, user);
  } finally {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
}

describe("a version's value", () => {
  test("every version, the current one too, shows a hidden value with Reveal and Copy, and no value is on the page", async () => {
    const { s, client, reveals: asked } = await threeVersions();
    mount(client);
    await openSecrets();
    const user = userEvent.setup();
    const region = await history(user);
    for (const n of [1, 2, 3]) {
      const row = rowOf(region, n);
      expect(row.getByText("Hidden value")).toBeTruthy();
      expect(row.getByRole("button", { name: `Reveal API_KEY version ${n}` })).toBeTruthy();
      expect(row.getByRole("button", { name: `Copy API_KEY version ${n}` })).toBeTruthy();
    }
    // the current version cannot be rolled back to; the others can
    expect(rowOf(region, 3).queryByRole("button", { name: /^Restore/ })).toBeNull();
    expect(
      rowOf(region, 2).getByRole("button", { name: "Restore API_KEY to version 2" }),
    ).toBeTruthy();
    for (const value of [SECRET, SECOND, THIRD])
      expect(document.body.innerHTML).not.toContain(value);
    expect(asked).toHaveLength(0);
    expect(await reveals(s)).toHaveLength(0);
  });

  test("Reveal on an old version shows that version's value, in its row only; Hide hides it again", async () => {
    const { s, client, reveals: asked } = await threeVersions();
    mount(client);
    await openSecrets();
    const user = userEvent.setup();
    const region = await history(user);
    await user.click(rowOf(region, 2).getByRole("button", { name: "Reveal API_KEY version 2" }));
    expect((await rowOf(region, 2).findByText(SECOND)).className).toBe("revealed");
    expect(asked).toEqual(["?version=2"]);
    expect(rowOf(region, 1).queryByText(SECOND)).toBeNull();
    expect(rowOf(region, 3).queryByText(SECOND)).toBeNull();
    for (const value of [SECRET, THIRD]) expect(document.body.textContent).not.toContain(value);
    const rows = await reveals(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({ version: 2 });

    await user.click(rowOf(region, 2).getByRole("button", { name: "Hide API_KEY version 2" }));
    expect(document.body.textContent).not.toContain(SECOND);
    expect(rowOf(region, 2).getByText("Hidden value")).toBeTruthy();
  });

  test("a plain variable's old value is behind the same Reveal: the list never held it", async () => {
    const { client, reveals: asked } = await threeVersions({ plain: true });
    mount(client);
    await openSecrets();
    const user = userEvent.setup();
    const region = await history(user);
    expect(document.body.textContent).not.toContain(SECRET);
    await user.click(rowOf(region, 1).getByRole("button", { name: "Reveal API_KEY version 1" }));
    expect(await rowOf(region, 1).findByText(SECRET)).toBeTruthy();
    expect(asked).toEqual(["?version=1"]);
  });

  test("Copy puts that version's value on the clipboard, says so, and leaves the value off the page", async () => {
    const { s, client, reveals: asked } = await threeVersions();
    mount(client);
    await openSecrets();
    await withClipboard(async (written, user) => {
      const region = await history(user);
      await user.click(rowOf(region, 1).getByRole("button", { name: "Copy API_KEY version 1" }));
      expect((await within(region).findByRole("status")).textContent).toBe(
        "Copied the value of API_KEY version 1",
      );
      expect(written).toEqual([SECRET]);
      expect(asked).toEqual(["?version=1"]);
      expect(document.body.textContent).not.toContain(SECRET);
      expect(document.body.innerHTML).not.toContain(SECRET);
      const rows = await reveals(s);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata).toMatchObject({ version: 1 });
    });
  });

  test("without the right to reveal, Reveal and Copy say so, show and copy nothing, and write no audit row", async () => {
    const { s, client } = await threeVersions({ reporter: true });
    mount(client);
    await openSecrets();
    await withClipboard(async (written, user) => {
      const region = await history(user);
      await user.click(rowOf(region, 2).getByRole("button", { name: "Copy API_KEY version 2" }));
      expect((await within(region).findByRole("alert")).textContent).toBe(
        "You cannot reveal values here",
      );
      expect(written).toEqual([]);
      await user.click(rowOf(region, 2).getByRole("button", { name: "Reveal API_KEY version 2" }));
      expect((await rowOf(region, 2).findByRole("alert")).textContent).toBeTruthy();
      for (const value of [SECRET, SECOND, THIRD])
        expect(document.body.textContent).not.toContain(value);
      expect(await reveals(s)).toHaveLength(0);
    });
  });

  test("rolling back adds a version that reveals as the old value, and the old versions stay", async () => {
    const { s, client } = await threeVersions();
    mount(client);
    await openSecrets();
    const user = userEvent.setup();
    const region = await history(user);
    await user.click(
      rowOf(region, 1).getByRole("button", { name: "Restore API_KEY to version 1" }),
    );
    const form = await screen.findByRole("form", { name: "Restore API_KEY to version 1" });
    await user.click(within(form).getByRole("button", { name: "Restore version" }));
    // the write closes the drawer; the history is opened afresh and shows the new version
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    await user.click(screen.getByRole("button", { name: "More actions for API_KEY" }));
    await user.click(screen.getByRole("menuitem", { name: "Version history" }));
    const again = await screen.findByRole("region", { name: "History of API_KEY" });
    await within(again).findByRole("list", { name: "Versions of API_KEY" });
    await user.click(rowOf(again, 4).getByRole("button", { name: "Reveal API_KEY version 4" }));
    expect(await rowOf(again, 4).findByText(SECRET)).toBeTruthy();
    expect(
      within(again)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual(["Version 4", "Version 3", "Version 2", "Version 1"]);
    const updates = await s.audit("variable.update"); // the two edits, and the roll back that names its version
    expect(updates).toHaveLength(3);
    expect(
      updates.map((u) => (u.metadata as { restoredVersion?: number }).restoredVersion),
    ).toContain(1);
  });
});

describe("the timeline (VUI-15)", () => {
  test("is an ordered list, newest first: each version's head holds its number, Current, the time and its icon buttons, then the value box, then who changed it", async () => {
    const { client } = await threeVersions();
    mount(client);
    await openSecrets();
    const user = userEvent.setup();
    const region = await history(user);
    const list = within(region).getByRole("list", { name: "Versions of API_KEY" });
    expect(list.tagName).toBe("OL");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual([
      "Version 3",
      "Version 2",
      "Version 1",
    ]);
    const labels = (item: HTMLElement) =>
      within(item.querySelector(".tl-head") as HTMLElement)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"));
    const head = (item: HTMLElement) => item.querySelector(".tl-head") as HTMLElement;
    // the head: number and Current on the left, the time, the three icon buttons at the right
    expect(head(items[0] as HTMLElement).textContent).toContain("Current");
    expect(head(items[1] as HTMLElement).textContent).not.toContain("Current");
    expect(head(items[0] as HTMLElement).querySelector("time")).not.toBeNull();
    expect(labels(items[0] as HTMLElement)).toEqual([
      "Copy API_KEY version 3",
      "Reveal API_KEY version 3",
    ]);
    expect(labels(items[1] as HTMLElement)).toEqual([
      "Copy API_KEY version 2",
      "Reveal API_KEY version 2",
      "Restore API_KEY to version 2",
    ]);
    // an icon button's name is its title too, and the picture is not read out
    for (const item of items)
      for (const b of within(head(item as HTMLElement)).getAllByRole("button")) {
        expect(b.getAttribute("title")).toBe(b.getAttribute("aria-label"));
        expect(b.querySelector("svg.ico")).not.toBeNull();
        expect(b.textContent).toBe("");
      }
    // below the head: the masked box, then the "Changed by" line
    for (const item of items) {
      const kids = Array.from(item.children).map((c) => c.className.split(" ")[0]);
      expect(kids).toEqual(["tl-head", "tl-value", "tl-by"]);
      expect(item.querySelector(".tl-value")?.textContent).toContain("Hidden value");
      expect(item.querySelector(".tl-by")?.textContent).toMatch(/^Changed by [a-z]+ [0-9a-f]{8}/);
    }
    // the hint under the header stays one line, said once
    expect(within(region).getAllByText(/A value stays hidden/)).toHaveLength(1);
  });

  test("Reveal turns into Hide in the same place, and the value shows in the box under the head, not in it", async () => {
    const { client } = await threeVersions();
    mount(client);
    await openSecrets();
    const user = userEvent.setup();
    const region = await history(user);
    const item = within(region).getByRole("listitem", { name: "Version 2" });
    await user.click(within(item).getByRole("button", { name: "Reveal API_KEY version 2" }));
    expect(await within(item).findByText(SECOND)).toBeTruthy();
    expect(item.querySelector(".tl-value")?.textContent).toContain(SECOND);
    expect(item.querySelector(".tl-head")?.textContent).not.toContain(SECOND);
    const hide = within(item.querySelector(".tl-head") as HTMLElement).getByRole("button", {
      name: "Hide API_KEY version 2",
    });
    expect(hide.getAttribute("title")).toBe("Hide API_KEY version 2");
  });
});
