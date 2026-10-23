import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, mount, pathOf, startBackend } from "./testing";
import {
  must,
  openSecrets,
  ref,
  SECRET,
  scene as sceneOn,
  withClipboard,
} from "./variables.fixture";

// VUI-4: a row's own actions (Edit, Copy value and the ⋯ menu), and Copy value's use of the audited reveal route.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);

/** A client that notes the path of every request it makes. */
function watched(cookie: string) {
  const paths: string[] = [];
  const client = clientVia(backend.api, cookie, (request, send) => {
    paths.push(`${request.method} ${pathOf(request)}`);
    return send();
  });
  return {
    client,
    paths,
    reveals: () => paths.filter((p) => /^GET .*\/variables\/[^/]+\/value$/.test(p)),
  };
}

const edit = (key: string) => screen.getByRole("button", { name: `Edit ${key}` });
const copy = (key: string) => screen.getByRole("button", { name: `Copy value of ${key}` });
const more = (key: string) => screen.getByRole("button", { name: `More actions for ${key}` });
const items = () => screen.getAllByRole("menuitem").map((i) => i.textContent);
const status = () => screen.queryByRole("status")?.textContent;
const nothingOf = (value: string) => expect(document.body.textContent).not.toContain(value);

describe("a row's buttons", () => {
  test("each variable has Edit, Copy value and a menu, named for its key; a key that does not resolve has none; the column is named for a screen reader", async () => {
    const s = await scene();
    await s.put.project("DB_PASS", SECRET, true);
    await s.put.project("REGION", "eu");
    await s.put.project("BROKEN", ref("NOWHERE"));
    mount(s.client);
    const table = await openSecrets();
    for (const key of ["DB_PASS", "REGION"]) {
      expect(edit(key)).toBeTruthy();
      expect(copy(key)).toBeTruthy();
      expect(more(key).getAttribute("aria-haspopup")).toBe("menu");
    }
    expect(
      screen.queryByRole("button", { name: /^(Edit|Copy value of|More actions for) BROKEN$/ }),
    ).toBeNull();
    const head = within(table).getByRole("columnheader", { name: "Actions" });
    expect(head.querySelector(".visually-hidden")).toBeTruthy();
    // they sit in the row they act on, in their own cell
    const row = within(table)
      .getByRole("rowheader", { name: "DB_PASS" })
      .closest("tr") as HTMLElement;
    expect(row.contains(edit("DB_PASS"))).toBe(true);
    expect(edit("DB_PASS").closest("td")?.className).toContain("row-actions");
    // the name still opens the details, and nothing else of the row changed its name
    expect(within(table).getByRole("button", { name: "DB_PASS" })).toBeTruthy();
  });

  test("Edit opens the edit form for that row, not the details", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    await userEvent.setup().click(edit("REGION"));
    expect(await screen.findByRole("form", { name: "Edit REGION" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "REGION" })).toBeNull();
  });
});

describe("the menu", () => {
  test("a secret set above the environment has every item, with Delete last", async () => {
    const s = await scene();
    await s.put.project("DB_PASS", SECRET, true);
    mount(s.client);
    await openSecrets();
    await userEvent.setup().click(more("DB_PASS"));
    expect(items()).toEqual([
      "Edit details",
      "Add tags",
      "Version history",
      "Rotation",
      "Add override",
      "Copy value",
      "Delete",
    ]);
    expect(screen.getByRole("menuitem", { name: "Delete" }).className).toContain("danger");
  });

  test("a plain value set in the environment has no Rotation (a secret's) and no Add override (it is the override)", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    await openSecrets();
    await userEvent.setup().click(more("COLOR"));
    expect(items()).toEqual([
      "Edit details",
      "Add tags",
      "Version history",
      "Copy value",
      "Delete",
    ]);
  });

  test("Edit details opens the details in the drawer", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(more("REGION"));
    await user.click(screen.getByRole("menuitem", { name: "Edit details" }));
    expect(await screen.findByRole("region", { name: "REGION" })).toBeTruthy();
    // the drawer has the focus (VUI-6); closing it puts the focus back on the button that opened the menu
    const dialog = screen.getByRole("dialog", { name: "REGION in dev" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more("REGION"));
  });

  test("Add tags opens the description and tags form with what the variable has now", async () => {
    const s = await scene();
    await s.scope.variables
      .post({
        key: "REGION",
        kind: "plain",
        value: "eu",
        description: "Where it runs",
        tags: ["eu", "ops"],
      })
      .then(must);
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(more("REGION"));
    await user.click(screen.getByRole("menuitem", { name: "Add tags" }));
    const form = await screen.findByRole("form", { name: "Describe and tag REGION" });
    expect((within(form).getByLabelText("What it is for") as HTMLInputElement).value).toBe(
      "Where it runs",
    );
    expect((within(form).getByLabelText("Tags") as HTMLInputElement).value).toBe("eu, ops");
  });

  test("Version history and Rotation open their panels", async () => {
    const s = await scene();
    await s.put.project("DB_PASS", SECRET, true);
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(more("DB_PASS"));
    await user.click(screen.getByRole("menuitem", { name: "Version history" }));
    expect(await screen.findByRole("region", { name: "History of DB_PASS" })).toBeTruthy();
    await user.click(more("DB_PASS"));
    await user.click(screen.getByRole("menuitem", { name: "Rotation" }));
    expect(await screen.findByRole("region", { name: "Rotation of DB_PASS" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "History of DB_PASS" })).toBeNull();
    nothingOf(SECRET);
  });

  test("Add override opens the add form for this key, in this environment", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(more("REGION"));
    await user.click(screen.getByRole("menuitem", { name: "Add override" }));
    const form = await screen.findByRole("form", { name: "Add a variable" });
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("REGION");
    expect(
      (within(form).getByLabelText("Applies to") as HTMLSelectElement).selectedOptions[0]
        ?.textContent,
    ).toBe("Only dev");
  });

  test("Delete asks first, as the details' button does, and removes nothing until it is confirmed", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(more("REGION"));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const form = await screen.findByRole("form", { name: "Delete REGION" });
    expect(form.textContent).toContain("Every environment that gets it from there loses it too.");
    const table = screen.getByRole("table", { name: "Variables in dev" });
    expect(within(table).getByRole("button", { name: "REGION" })).toBeTruthy();
    expect(await s.audit("variable.delete")).toHaveLength(0);
    await user.click(within(form).getByRole("button", { name: "Delete variable" }));
    // the only variable: the table gives way to the empty message
    expect(await screen.findByText("No variables in dev yet.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Variables in dev" })).toBeNull();
    expect(await s.audit("variable.delete")).toHaveLength(1);
  });

  test("a row's panel takes the place of another row's details, and keeps its own row's", async () => {
    const s = await scene();
    await s.put.project("ALPHA", "1");
    await s.put.project("BETA", "2");
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "ALPHA" }));
    expect(await screen.findByRole("region", { name: "ALPHA" })).toBeTruthy();
    // the same row's history opens in the same drawer, under its details, as the details' own button does
    await user.click(more("ALPHA"));
    await user.click(screen.getByRole("menuitem", { name: "Version history" }));
    expect(await screen.findByRole("region", { name: "History of ALPHA" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "ALPHA" })).toBeTruthy();
    // another row's does not leave the first row's details on the screen
    await user.click(more("BETA"));
    await user.click(screen.getByRole("menuitem", { name: "Version history" }));
    expect(await screen.findByRole("region", { name: "History of BETA" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "ALPHA" })).toBeNull();
  });

  test("a read that fails says so instead of opening a form with nothing in it (Add tags)", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    const failing = clientVia(backend.api, s.cookie, async (request, send) =>
      request.method === "GET" && /\/variables\/[^/]+$/.test(pathOf(request))
        ? new Response(JSON.stringify({ error: "down for a moment" }), { status: 500 })
        : send(),
    );
    mount(failing);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(more("REGION"));
    await user.click(screen.getByRole("menuitem", { name: "Add tags" }));
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Describe and tag REGION" })).toBeNull();
  });
});

describe("Copy value", () => {
  test("a secret: one read of the audited route, the clipboard gets the value, the page never does", async () => {
    const s = await scene();
    await s.put.project("DB_PASS", SECRET, true);
    const { client, reveals } = watched(s.cookie);
    mount(client);
    await openSecrets();
    await withClipboard("keeps", async (written, user) => {
      await user.click(copy("DB_PASS"));
      await waitFor(() => expect(status()).toBe("Copied the value of DB_PASS"));
      expect(written).toEqual([SECRET]);
      expect(reveals()).toHaveLength(1);
      expect(await s.audit("variable.reveal")).toHaveLength(1);
      nothingOf(SECRET);
    });
  });

  test("from the menu it is the same: one read, the value on the clipboard, none in the page", async () => {
    const s = await scene();
    await s.put.env("dev", "DB_PASS", SECRET, true);
    const { client, reveals } = watched(s.cookie);
    mount(client);
    await openSecrets();
    await withClipboard("keeps", async (written, user) => {
      await user.click(more("DB_PASS"));
      await user.click(screen.getByRole("menuitem", { name: "Copy value" }));
      await waitFor(() => expect(status()).toBe("Copied the value of DB_PASS"));
      expect(written).toEqual([SECRET]);
      expect(reveals()).toHaveLength(1);
      expect(await s.audit("variable.reveal")).toHaveLength(1);
      nothingOf(SECRET);
    });
  });

  test("a plain value is copied as it is, with no request and no audit row", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu-west-1");
    const { client, paths, reveals } = watched(s.cookie);
    mount(client);
    await openSecrets();
    await withClipboard("keeps", async (written, user) => {
      const before = paths.length;
      await user.click(copy("REGION"));
      await waitFor(() => expect(status()).toBe("Copied the value of REGION"));
      expect(written).toEqual(["eu-west-1"]);
      expect(reveals()).toHaveLength(0);
      expect(paths.slice(before)).toEqual([]);
      expect(await s.audit("variable.reveal")).toHaveLength(0);
    });
  });

  test("an empty plain value copies as the empty string, not as the words (empty)", async () => {
    const s = await scene();
    await s.put.project("BLANK", "");
    mount(s.client);
    await openSecrets();
    await withClipboard("keeps", async (written, user) => {
      await user.click(copy("BLANK"));
      await waitFor(() => expect(status()).toBe("Copied the value of BLANK"));
      expect(written).toEqual([""]);
    });
  });

  test("without the right to reveal, it says so, copies nothing and writes no audit row", async () => {
    const s = await scene({ reporter: true });
    await s.put.project("DB_PASS", SECRET, true);
    mount(s.client);
    await openSecrets();
    await withClipboard("keeps", async (written, user) => {
      await user.click(copy("DB_PASS"));
      expect((await screen.findByRole("alert")).textContent).toBe("You cannot reveal values here");
      expect(written).toEqual([]);
      expect(status()).toBeUndefined();
      expect(await s.audit("variable.reveal")).toHaveLength(0);
      nothingOf(SECRET);
    });
  });

  test("a clipboard that refuses, or none, says so and shows no value; a later copy clears the message", async () => {
    const s = await scene();
    await s.put.project("DB_PASS", SECRET, true);
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    await withClipboard("refuses", async (_written, user) => {
      await user.click(copy("DB_PASS"));
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Could not copy the value: no permission",
      );
      expect(status()).toBeUndefined();
      nothingOf(SECRET);
    });
    await withClipboard("none", async (_written, user) => {
      await user.click(copy("REGION"));
      await waitFor(() =>
        expect(screen.getByRole("alert").textContent).toBe("Could not copy the value."),
      );
    });
    await withClipboard("keeps", async (written, user) => {
      await user.click(copy("REGION"));
      await waitFor(() => expect(status()).toBe("Copied the value of REGION"));
      expect(screen.queryByRole("alert")).toBeNull();
      expect(written).toEqual(["eu"]);
    });
  });

  test("the message is for a moment: it goes by itself", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    await withClipboard("keeps", async (_written, user) => {
      await user.click(copy("REGION"));
      await waitFor(() => expect(status()).toBe("Copied the value of REGION"));
      await waitFor(() => expect(status()).toBeUndefined(), { timeout: 5000 });
    });
  });

  test("it does not turn Reveal all on, and what Reveal all shows is left as it was", async () => {
    const s = await scene();
    await s.put.project("DB_PASS", SECRET, true);
    mount(s.client);
    const table = await openSecrets();
    await withClipboard("keeps", async (_written, user) => {
      await user.click(copy("DB_PASS"));
      await waitFor(() => expect(status()).toBe("Copied the value of DB_PASS"));
      expect(within(table).getByText("Hidden value")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
    });
  });
});
