import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";
import { variablesAt } from "./variable-parts";
import {
  addNew,
  cellOf,
  detailsOf,
  fromMenu,
  must,
  SECRET,
  scene as sceneOn,
  showCompare,
} from "./variables.fixture";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
const scene = (options?: { reporter?: boolean; environments?: string[] }) =>
  sceneOn(backend, options);
beforeEach(() => {
  window.location.hash = "#/variables";
  try {
    localStorage.clear();
  } catch {
    // the page copes without it
  }
});

type User = ReturnType<typeof userEvent.setup>;

/** The history panel once its versions have loaded. */
const historyOf = async (key: string) => {
  const region = await screen.findByRole("region", { name: `History of ${key}` });
  await within(region).findByRole("list", { name: `Versions of ${key}` });
  return region;
};
const openHistory = async (user: User, key: string, env: string) => {
  await fromMenu(user, key, env, "Version history");
  return historyOf(key);
};
/** A secret's value shown in its details: Reveal is a button of the details, not of the line. */
const showSecret = async (user: User, key: string, env: string, shown: string) => {
  const dialog = await detailsOf(user, key, env);
  await user.click(await within(dialog).findByRole("button", { name: `Reveal ${key} in ${env}` }));
  await within(dialog).findByText(shown);
  return dialog;
};
/** The versions of the timeline, newest first: a version is one list item named "Version N" (VUI-15). */
const versionsShown = (region: HTMLElement) =>
  within(region)
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("aria-label")?.replace("Version ", ""));
/** Waits for both panels to be gone; a boolean, because bun prints a failed DOM node whole. */
const panelsClosed = () =>
  waitFor(() =>
    expect(
      screen.queryByRole("form", { name: /^Restore / }) === null &&
        screen.queryByRole("region", { name: /^History of / }) === null,
    ).toBe(true),
  );

describe("the history of a variable", () => {
  test("lists the versions newest first with who and why, no value until one is asked for, and marks the current one", async () => {
    const s = await scene();
    const v = await s.put.project("API_KEY", SECRET, true);
    const edit = s.scope.variables({ varId: v.id });
    must(await edit.patch({ value: "second-value-22" }));
    must(await edit.patch({ value: "third-value-33", reason: "rotated after the leak scare" }));
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openHistory(user, "API_KEY", "dev");

    expect(versionsShown(region)).toEqual(["3", "2", "1"]);
    const rows = within(region).getAllByRole("listitem");
    expect(rows[0]?.textContent).toContain("Current");
    expect(rows[0]?.textContent).toContain("rotated after the leak scare");
    // who and when: the kind of actor with a short id, a date in UTC, and a machine-readable time
    expect(rows[0]?.textContent).toMatch(/[a-z]+ [0-9a-f]{8}/);
    expect(rows[0]?.textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(region.querySelector("time")?.getAttribute("datetime")).toMatch(
      /^\d{4}-\d{2}-\d{2}T.*Z$/,
    );
    // the current version cannot be restored; its only buttons are the Reveal and Copy every version has (VUI-6)
    expect(within(rows[0] as HTMLElement).queryByRole("button", { name: /^Restore/ })).toBeNull();
    expect(
      within(rows[0] as HTMLElement)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Copy API_KEY version 3", "Reveal API_KEY version 3"]);
    expect(
      within(region).getByRole("button", { name: "Restore API_KEY to version 2" }),
    ).toBeTruthy();
    expect(
      within(region).getByRole("button", { name: "Restore API_KEY to version 1" }),
    ).toBeTruthy();
    for (const hidden of [SECRET, "second-value-22", "third-value-33"]) {
      expect(document.body.textContent?.includes(hidden)).toBe(false);
    }
    // reading the history is not a reveal
    expect(await s.audit("variable.reveal")).toHaveLength(0);
  });

  test("a variable that was never changed has nothing to go back to, and the X leaves the history", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openHistory(user, "REGION", "dev");
    expect(versionsShown(region)).toEqual(["1"]);
    expect(within(region).queryByRole("button", { name: /^Restore/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(screen.queryByRole("region", { name: "History of REGION" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add New" })).toBeTruthy();
  });

  test("going back asks first: cancel changes nothing, confirming adds a version that holds the old value", async () => {
    const s = await scene();
    const v = await s.put.project("API_KEY", SECRET, true);
    must(await s.scope.variables({ varId: v.id }).patch({ value: "second-value-22" }));
    const { queries } = mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openHistory(user, "API_KEY", "dev");

    await user.click(within(region).getByRole("button", { name: "Restore API_KEY to version 1" }));
    const form = screen.getByRole("form", { name: "Restore API_KEY to version 1" });
    expect(form.textContent).toContain("adds a new version");
    expect(form.textContent).toContain("belongs to the project");
    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    // back at the history, with nothing changed
    expect(versionsShown(await historyOf("API_KEY"))).toEqual(["2", "1"]);
    expect(await s.audit("variable.update")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Restore API_KEY to version 1" }));
    await user.type(screen.getByLabelText("Why (optional)"), "the new key broke the build");
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    await panelsClosed();

    const listed = must(
      await s.scope.variables({ varId: v.id }).versions.get({ query: { limit: 100 } }),
    ).items;
    expect(listed.map((x) => x.version)).toEqual([3, 2, 1]);
    expect(listed[0]?.reason).toBe("the new key broke the build");
    const updates = await s.audit("variable.update");
    expect(updates).toHaveLength(2);
    const restored = updates.find(
      (row) => (row.metadata as { restoredVersion?: number }).restoredVersion === 1,
    );
    expect(restored?.metadata).toMatchObject({ version: 3, restoredVersion: 1 });
    expect(JSON.stringify(updates)).not.toContain(SECRET);

    // opened again, the history has the new version
    expect(versionsShown(await openHistory(user, "API_KEY", "dev"))).toEqual(["3", "2", "1"]);
    await user.click(screen.getByRole("button", { name: "Close drawer" }));

    // the secret is back, and it is the old value that a reveal now gives
    await showSecret(user, "API_KEY", "dev", SECRET);
    expect(
      JSON.stringify(
        queries
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);
  });

  test("opening another variable's history replaces the one that was open, restore form included", async () => {
    const s = await scene();
    for (const key of ["FIRST", "SECOND"]) {
      const v = await s.put.project(key, "a");
      must(await s.scope.variables({ varId: v.id }).patch({ value: "b" }));
    }
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openHistory(user, "FIRST", "dev");
    await user.click(within(region).getByRole("button", { name: "Restore FIRST to version 1" }));
    await screen.findByRole("form", { name: "Restore FIRST to version 1" });
    await fromMenu(user, "SECOND", "dev", "Version history");
    const other = await historyOf("SECOND");
    expect(versionsShown(other)).toEqual(["2", "1"]);
    expect(screen.queryByRole("form", { name: /^Restore / }) === null).toBe(true);
    expect(screen.queryByRole("region", { name: "History of FIRST" }) === null).toBe(true);
  });

  test("a value shown in the grid is the restored one", async () => {
    const s = await scene();
    const v = await s.put.env("dev", "LOG_LEVEL", "info");
    must(
      await s.scope
        .environments({ envId: s.envs.dev ?? "" })
        .variables({ varId: v.id })
        .patch({ value: "debug" }),
    );
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    expect(cellOf("LOG_LEVEL", "dev").textContent).toContain("debug");
    const region = await openHistory(user, "LOG_LEVEL", "dev");
    await user.click(
      within(region).getByRole("button", { name: "Restore LOG_LEVEL to version 1" }),
    );
    // an environment's own value does not claim to change anything else
    expect(
      screen.getByRole("form", { name: "Restore LOG_LEVEL to version 1" }).textContent,
    ).not.toContain("belongs to");
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    await panelsClosed();
    await waitFor(() => expect(cellOf("LOG_LEVEL", "dev").textContent).toContain("info"));
  });

  test.each(["organization", "project", "environment"] as const)(
    "a %s value is restored through its own level",
    async (level) => {
      const s = await scene();
      const made =
        level === "organization"
          ? await s.put.org("REGION", "eu")
          : level === "project"
            ? await s.put.project("REGION", "eu")
            : await s.put.env("dev", "REGION", "eu");
      must(
        await variablesAt(
          s.client,
          s.org.id,
          s.project.id,
          level,
          s.envs.dev,
        )({ varId: made.id }).patch({
          value: "us",
        }),
      );
      mount(s.client);
      await showCompare();
      const user = userEvent.setup();
      await screen.findByRole("table");
      const region = await openHistory(user, "REGION", "dev");
      await user.click(within(region).getByRole("button", { name: "Restore REGION to version 1" }));
      await user.click(screen.getByRole("button", { name: "Restore version" }));
      await panelsClosed();
      await waitFor(() => expect(cellOf("REGION", "dev").textContent).toContain("eu"));
    },
  );

  test("a restore the API refuses says why and keeps the form", async () => {
    const s = await scene({ reporter: true });
    const v = await s.put.project("REGION", "eu");
    must(await s.scope.variables({ varId: v.id }).patch({ value: "us" }));
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openHistory(user, "REGION", "dev");
    await user.click(within(region).getByRole("button", { name: "Restore REGION to version 1" }));
    await user.click(screen.getByRole("button", { name: "Restore version" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/permission|allowed|forbidden/i);
    expect(screen.getByRole("form", { name: "Restore REGION to version 1" })).toBeTruthy();
    expect(await s.audit("variable.update")).toHaveLength(1);
  });

  test("a history that cannot be loaded says so and can be tried again", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    let failing = true;
    const client = clientVia(backend.api, s.cookie, async (request, send) =>
      failing && pathOf(request).endsWith("/versions") ? down("the history store is down") : send(),
    );
    mount(client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await fromMenu(user, "REGION", "dev", "Version history");
    expect((await screen.findByRole("alert")).textContent).toContain("the history store is down");
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(versionsShown(await historyOf("REGION"))).toEqual(["1"]);
  });
});

const NAMES = "NEW_ONE=alpha-secret-11\nEXISTING=different-value-22\nSAME=same-value-33\n";

const openImport = async (user: User) => {
  await addNew(user, "Import variables");
  return screen.getByRole("form", { name: "Import variables" });
};
const paste = async (user: User, text: string) => {
  await user.click(screen.getByLabelText("Text to import"));
  await user.paste(text);
};
const result = () => screen.findByRole("status", { name: "Import result" });
const textBox = () => screen.getByLabelText("Text to import") as HTMLTextAreaElement;

/** An organization whose project already holds two of the names that NAMES brings, as secrets. */
async function existing() {
  const s = await scene();
  await s.put.project("EXISTING", "old-value-00", true);
  await s.put.project("SAME", "same-value-33", true);
  return s;
}

describe("importing variables", () => {
  test("the preview names each key and what would happen to it, never a value, and writes nothing", async () => {
    const s = await existing();
    const { queries } = mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openImport(user);
    await paste(user, NAMES);
    await user.click(screen.getByRole("button", { name: "Preview" }));

    const shown = await result();
    const rows = within(shown)
      .getAllByRole("row")
      .slice(1)
      .map((r) => Array.from(r.querySelectorAll("th, td")).map((c) => c.textContent));
    expect(rows).toEqual([
      ["EXISTING", "secret", "Exists with a different value (kept)"],
      ["NEW_ONE", "secret", "New"],
      ["SAME", "secret", "Same value"],
    ]);
    expect(shown.textContent).toContain("Nothing has been saved yet");
    for (const value of [
      "alpha-secret-11",
      "different-value-22",
      "same-value-33",
      "old-value-00",
    ]) {
      expect(shown.textContent?.includes(value)).toBe(false);
    }
    expect(
      JSON.stringify(
        queries
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("alpha-secret-11");
    // the pasted text is kept out of autofill and spell checking
    expect(textBox().getAttribute("autocomplete")).toBe("off");
    expect(textBox().getAttribute("spellcheck")).toBe("false");

    // nothing was written; the dry run is on record as one import
    const listed = must(await s.scope.variables.get({ query: { limit: 100 } })).items;
    expect(listed.map((x) => x.key).sort()).toEqual(["EXISTING", "SAME"]);
    expect(await s.audit("variable.create")).toHaveLength(2);
    expect(await s.audit("variable.import")).toHaveLength(1);
  });

  test("a change can only be applied after a preview of the same text and options", async () => {
    const s = await existing();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openImport(user);
    const preview = screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement;
    expect(preview.disabled).toBe(true);
    await paste(user, NAMES);
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();

    const previewed = async () => {
      await user.click(screen.getByRole("button", { name: "Preview" }));
      await result();
      expect(screen.getByRole("button", { name: "Apply import" })).toBeTruthy();
    };
    const gone = () =>
      expect(
        screen.queryByRole("status", { name: "Import result" }) === null &&
          screen.queryByRole("button", { name: "Apply import" }) === null,
      ).toBe(true);

    await previewed();
    await user.type(textBox(), "MORE=1");
    gone();
    await previewed();
    await user.click(screen.getByLabelText("Replace values that differ"));
    gone();
    await previewed();
    await user.selectOptions(screen.getByLabelText("Format"), "json");
    gone();
    await user.selectOptions(screen.getByLabelText("Format"), "dotenv");
    await previewed();
    await user.selectOptions(screen.getByLabelText("Kind of every value"), "plain");
    gone();
    await previewed();
    await user.selectOptions(screen.getByLabelText("Applies to"), "organization");
    gone();
    expect(await s.audit("variable.create")).toHaveLength(2);
  });

  test("applying creates the new names, keeps the conflicts, says what happened and drops the text", async () => {
    const s = await existing();
    const { queries } = mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openImport(user);
    await paste(user, NAMES);
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await result();
    await user.click(screen.getByRole("button", { name: "Apply import" }));

    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Import result" }).textContent).toContain(
        "1 created",
      ),
    );
    const shown = screen.getByRole("status", { name: "Import result" });
    expect(shown.textContent).toContain("1 created, 0 changed, 1 the same, 1 kept.");
    expect(within(shown).getByText("Created")).toBeTruthy();
    expect(textBox().value).toBe("");
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();
    // the grid behind the panel has the new name, and the kept one still holds its own value
    // (the summary appears once the grid has reloaded, so no waiting is needed)
    expect(cellOf("NEW_ONE", "dev").textContent).not.toContain("alpha-secret-11");
    await showSecret(user, "EXISTING", "dev", "old-value-00");

    const listed = must(await s.scope.variables.get({ query: { limit: 100 } })).items;
    expect(listed.map((x) => [x.key, x.kind]).sort()).toEqual([
      ["EXISTING", "secret"],
      ["NEW_ONE", "secret"],
      ["SAME", "secret"],
    ]);
    const created = await s.audit("variable.create");
    expect(created).toHaveLength(3);
    expect(
      created.filter((row) => (row.metadata as { source?: string }).source === "dotenv"),
    ).toHaveLength(1);
    const everything = JSON.stringify([
      created,
      await s.audit("variable.import"),
      await s.audit("variable.update"),
      queries
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ]);
    for (const value of ["alpha-secret-11", "different-value-22"]) {
      expect(everything).not.toContain(value);
      expect(document.body.textContent?.includes(value)).toBe(false);
    }

    // (the details of EXISTING are open now: the drawer's X closes both)
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    expect(screen.queryByRole("form", { name: "Import variables" })).toBeNull();
  });

  test("replacing values that differ shows them as changes and applies them", async () => {
    const s = await existing();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openImport(user);
    await paste(user, NAMES);
    await user.click(screen.getByLabelText("Replace values that differ"));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(within(await result()).getByText("Will change")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Import result" }).textContent).toContain(
        "1 changed",
      ),
    );
    const listed = must(await s.scope.variables.get({ query: { limit: 100 } })).items;
    const revealed = async (key: string) =>
      must(
        await s.scope
          .variables({ varId: listed.find((x) => x.key === key)?.id ?? "" })
          .value.get({ query: {} }),
      ).value;
    expect(await revealed("EXISTING")).toBe("different-value-22");
    expect(await revealed("SAME")).toBe("same-value-33");
    expect(await revealed("NEW_ONE")).toBe("alpha-secret-11");
    expect(await s.audit("variable.update")).toHaveLength(1);
  });

  test("a secret that was on show is hidden again once an import has replaced it", async () => {
    const s = await existing();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await showSecret(user, "EXISTING", "dev", "old-value-00");
    await openImport(user);
    await paste(user, "EXISTING=different-value-22\n");
    await user.click(screen.getByLabelText("Replace values that differ"));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await result();
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Import result" }).textContent).toContain(
        "1 changed",
      ),
    );
    // the old value is gone from the screen, and the details ask to be revealed again
    expect(document.body.textContent?.includes("old-value-00")).toBe(false);
    // the details stay open beside the import's panel, so the drawer is named for the import
    expect(
      (await screen.findByRole("button", { name: "Reveal EXISTING in dev" })).isConnected,
    ).toBe(true);
  });

  test("plain values can be imported, and show in the grid", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await user.selectOptions(screen.getByLabelText("Kind of every value"), "plain");
    await paste(user, "REGION=eu\nLOG_LEVEL=info\n");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await result();
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    // the summary appears once every environment's set has been fetched again
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Import result" }).textContent).toContain(
        "2 created",
      ),
    );
    expect(cellOf("REGION", "dev").textContent).toContain("eu");
    expect(cellOf("LOG_LEVEL", "staging").textContent).toContain("info");
  });

  test("lines that cannot be read are listed by line number, without their text", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await paste(user, "GOOD=ok-11\nnot an assignment HUSHHUSH\n1BAD=bad-value-xx\nGOOD=ok-22\n");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const shown = await result();
    const left = within(shown)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(left).toHaveLength(3);
    expect(left[0]).toContain("Line 2");
    expect(left[0]).toContain("not a NAME=value line");
    expect(left[1]).toContain("Line 3");
    expect(left.find((t) => t?.includes("the name appears more than once"))).toContain("(GOOD)");
    for (const text of ["HUSHHUSH", "bad-value-xx", "ok-11", "ok-22"]) {
      expect(shown.textContent?.includes(text)).toBe(false);
    }
  });

  test("JSON is read as JSON, and a document that is not one is reported, not echoed", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await user.selectOptions(screen.getByLabelText("Format"), "json");
    await paste(user, "this is not json CLOUDY");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    const bad = await result();
    expect(within(bad).getAllByRole("listitem")).toHaveLength(1);
    expect(bad.textContent?.includes("CLOUDY")).toBe(false);
    expect(within(bad).getByText("Nothing would change.")).toBeTruthy();

    await user.clear(textBox());
    await paste(user, JSON.stringify({ FROM_JSON: "j-11" }));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("status", { name: "Import result" })).queryByText("FROM_JSON") ===
          null,
      ).toBe(false),
    );
  });

  test("a chosen file fills the text, and its name picks the format", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    const file = new File([JSON.stringify({ FROM_FILE: "f-11" })], "vars.json", {
      type: "application/json",
    });
    await user.upload(screen.getByLabelText("Or choose a file"), file);
    await waitFor(() => expect(textBox().value).toContain("FROM_FILE"));
    expect((screen.getByLabelText("Format") as HTMLSelectElement).value).toBe("json");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("status", { name: "Import result" })).queryByText("FROM_FILE") ===
          null,
      ).toBe(false),
    );
  });

  test("a file that is too large is refused before it is read", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await paste(user, "KEPT=1");
    await user.upload(
      screen.getByLabelText("Or choose a file"),
      new File(["x".repeat(1_048_577)], "big.env"),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("larger than 1 MiB");
    // what was already there is not thrown away because a wrong file was picked
    expect(textBox().value).toBe("KEPT=1");
  });

  test("a file that cannot be read says so and keeps the text", async () => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await paste(user, "KEPT=1");
    const file = new File(["A=1"], "locked.env");
    Object.defineProperty(file, "text", { value: () => Promise.reject(new Error("denied")) });
    await user.upload(screen.getByLabelText("Or choose a file"), file);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be read");
    expect(textBox().value).toBe("KEPT=1");
  });

  test.each([
    ["project", "project"],
    ["organization", "organization"],
    ["environment", "dev"],
  ] as const)("applies to the %s the form says", async (level, choice) => {
    const s = await scene();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await user.selectOptions(screen.getByLabelText("Kind of every value"), "plain");
    await user.selectOptions(
      screen.getByLabelText("Applies to"),
      choice === "dev" ? (s.envs.dev ?? "") : choice,
    );
    await paste(user, "WHERE=here\n");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await result();
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    await waitFor(() => expect(cellOf("WHERE", "dev").textContent).toContain("here"));
    const at = await variablesAt(s.client, s.org.id, s.project.id, level, s.envs.dev).get({
      query: { limit: 100 },
    });
    expect(must(at).items.map((x) => x.key)).toEqual(["WHERE"]);
    const others = (["project", "organization", "environment"] as const).filter((l) => l !== level);
    for (const other of others) {
      const list = await variablesAt(s.client, s.org.id, s.project.id, other, s.envs.dev).get({
        query: { limit: 100 },
      });
      expect(must(list).items).toHaveLength(0);
    }
  });

  test("an import the API refuses says why, writes nothing and keeps the text", async () => {
    const s = await scene({ reporter: true });
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await paste(user, "NOPE=nope-11");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/permission|allowed|forbidden/i);
    expect(textBox().value).toBe("NOPE=nope-11");
    expect(screen.queryByRole("status", { name: "Import result" })).toBeNull();
    expect(await s.audit("variable.create")).toHaveLength(0);
  });

  test("a preview of a text that has changed since is not shown", async () => {
    const s = await scene();
    let hold: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      hold = resolve;
    });
    const client = clientVia(backend.api, s.cookie, async (request, send) => {
      if (pathOf(request).endsWith("/variables/import")) await gate;
      return send();
    });
    mount(client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await paste(user, "FIRST=first-11");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.type(textBox(), "\nSECOND=second-22");
    hold?.();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /Preview|Checking/ }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(screen.queryByRole("status", { name: "Import result" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();
  });

  test("a failure that answers after the text has changed is not shown against the new text", async () => {
    const s = await scene();
    let hold: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      hold = resolve;
    });
    const client = clientVia(backend.api, s.cookie, async (request, send) => {
      if (!pathOf(request).endsWith("/variables/import")) return send();
      await gate;
      return down("a late failure");
    });
    mount(client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await paste(user, "FIRST=first-11");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await user.type(textBox(), "\nSECOND=second-22");
    hold?.();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByRole("alert") === null).toBe(true);
  });

  test("while an import is being saved it cannot be sent again", async () => {
    const s = await scene();
    let hold: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      hold = resolve;
    });
    let writes = 0;
    const client = clientVia(backend.api, s.cookie, async (request, send) => {
      if (pathOf(request).endsWith("/variables/import")) {
        const body = (await request.clone().json()) as { dryRun?: boolean };
        if (body.dryRun === false) {
          writes += 1;
          await gate;
        }
      }
      return send();
    });
    mount(client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByText(/No variables yet/);
    await openImport(user);
    await paste(user, "ONCE=1");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    await result();
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // the text and the options are being written: they cannot change under the request
    // (a field reports its own `disabled`, not its fieldset's: the fieldset is what holds them)
    const held = [textBox(), screen.getByLabelText("Replace values that differ")].map(
      (field) => field.closest("fieldset")?.disabled,
    );
    expect(held).toEqual([true, true]);
    expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "Saving…" }));
    hold?.();
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Import result" }).textContent).toContain(
        "1 created",
      ),
    );
    expect(writes).toBe(1);
  });

  test("a name that exists as another kind is kept and said so", async () => {
    const s = await scene();
    await s.put.project("SAME", "same-value-33");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openImport(user);
    await paste(user, "SAME=other-value-44\n");
    await user.click(screen.getByLabelText("Replace values that differ"));
    await user.click(screen.getByRole("button", { name: "Preview" }));
    // even when replacing, a secret does not silently become the kind of a plain value
    expect(within(await result()).getByText("Exists as a different kind (kept)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();
  });

  test("a preview that finds nothing to do offers no apply", async () => {
    const s = await scene();
    await s.put.project("EXISTING", "old-value-00");
    await s.put.project("SAME", "same-value-33");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await screen.findByRole("table");
    await openImport(user);
    await paste(user, "SAME=same-value-33\nEXISTING=different-value-22\n");
    await user.selectOptions(screen.getByLabelText("Kind of every value"), "plain");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    // SAME is the same and EXISTING is a conflict: nothing is new
    expect(within(await result()).getByText("Nothing would change.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();
  });
});
