import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import { must, openSecrets, ref, SECRET, scene as sceneOn } from "./variables.fixture";

// VWS-4: a row of the Secrets view opens its details, and the matrix's own forms work from there.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = () => sceneOn(backend);

/** Opens a variable's details from the list and returns the region they are in. */
async function details(key: string) {
  const table = await openSecrets();
  await userEvent.setup().click(within(table).getByRole("button", { name: key }));
  const region = await screen.findByRole("region", { name: key });
  // the facts come from a read of their own: the actions that need them wait for it
  await within(region).findByText("Version");
  return region;
}

describe("what a row's details say", () => {
  test("kind, where it comes from, its version, when it changed, what it is for, and what it overrides", async () => {
    const s = await scene();
    await s.put.project("COLOR", "blue");
    const here = await s.put.env("dev", "COLOR", "green");
    must(
      await s.scope
        .environments({ envId: s.envs.dev ?? "" })
        .variables({ varId: here.id })
        .patch({ description: "The brand colour" }),
    );
    mount(s.client);
    const region = await details("COLOR");
    const text = region.textContent ?? "";
    expect(within(region).getByText("The brand colour")).toBeTruthy();
    expect(text).toMatch(/Kind\s*plain/);
    expect(text).toMatch(/Source\s*Environment/);
    expect(text).toMatch(/Version\s*1/);
    expect(text).toMatch(/Last updated\s*\d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    await within(region).findByText("Overrides the Project value");
  });

  test("a variable with no description says so", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const region = await details("REGION");
    await within(region).findByText("No description");
    expect(within(region).queryByText(/Overrides/)).toBeNull();
  });

  test("a plain value is shown as it is written, with each reference marked", async () => {
    const s = await scene();
    await s.put.project("DB_HOST", "db.internal");
    await s.put.project("DB_ADDR", `${ref("DB_HOST")}:5432`);
    mount(s.client);
    const table = await openSecrets();
    // the list shows what the environment sees, the details how it is written
    expect(within(table).getByText("db.internal:5432")).toBeTruthy();
    await userEvent.setup().click(within(table).getByRole("button", { name: "DB_ADDR" }));
    const region = await screen.findByRole("region", { name: "DB_ADDR" });
    const written = await within(region).findByText(/:5432/);
    expect(written.textContent).toBe(`${ref("DB_HOST")}:5432`);
    expect(Array.from(written.querySelectorAll("mark")).map((m) => m.textContent)).toEqual([
      ref("DB_HOST"),
    ]);
  });

  test("a doubled dollar is a literal, so it is written as it is and not marked", async () => {
    const s = await scene();
    const text = `$${ref("NOT_A_REF")} or ${ref("REAL")}`;
    await s.put.project("PRICE", text);
    await s.put.project("REAL", "5");
    mount(s.client);
    const region = await details("PRICE");
    const written = await within(region).findByText(/NOT_A_REF/);
    expect(written.textContent).toBe(text);
    expect(Array.from(written.querySelectorAll("mark")).map((m) => m.textContent)).toEqual([
      ref("REAL"),
    ]);
  });

  test("a secret's value is not in the details until Reveal is pressed there", async () => {
    const s = await scene();
    await s.put.project("DB_PASSWORD", SECRET, true);
    mount(s.client);
    const region = await details("DB_PASSWORD");
    expect(document.body.textContent).not.toContain(SECRET);
    expect(within(region).getByText("Hidden value")).toBeTruthy();
    await userEvent
      .setup()
      .click(within(region).getByRole("button", { name: "Reveal DB_PASSWORD in dev" }));
    expect((await within(region).findByText(SECRET)).className).toBe("revealed");
  });

  test("the X removes them and puts focus back on the row's name", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await details("REGION");
    const user = userEvent.setup();
    // focus is somewhere else (the search box) when the X is used: it must not be left to fall to the page
    await user.click(screen.getByRole("searchbox", { name: "Search variables" }));
    const close = screen.getByRole("button", { name: "Close drawer" });
    close.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("region", { name: "REGION" })).toBeNull();
    // (the button in the list: the Changes drawer has one of its own for the key)
    const table = screen.getByRole("table", { name: "Variables in dev" });
    expect(document.activeElement).toBe(within(table).getByRole("button", { name: "REGION" }));
  });
});

describe("what can be done from the details", () => {
  test("the description is edited and shown again", async () => {
    const s = await scene();
    const color = await s.put.project("COLOR", "blue");
    mount(s.client);
    const region = await details("COLOR");
    const user = userEvent.setup();
    await user.click(
      within(region).getByRole("button", { name: "Edit description and tags of COLOR in dev" }),
    );
    const form = screen.getByRole("form", { name: "Describe and tag COLOR" });
    const box = within(form).getByLabelText("What it is for") as HTMLInputElement;
    expect(box.value).toBe("");
    await user.type(box, "The brand colour");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    // a write reads the details again, so they are a new region: find the text, then check where it is
    const shown = await screen.findByText("The brand colour");
    expect(
      within(screen.getByRole("region", { name: "COLOR" })).getByText("The brand colour"),
    ).toBe(shown);
    expect(screen.queryByRole("form", { name: "Describe and tag COLOR" })).toBeNull();
    const read = must(await s.scope.variables({ varId: color.id }).get());
    expect([read.description, read.value]).toEqual(["The brand colour", "blue"]);
  });

  test("the value is changed through the Edit form", async () => {
    const s = await scene();
    await s.put.project("COLOR", "blue");
    mount(s.client);
    const region = await details("COLOR");
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "Edit COLOR in dev" }));
    const box = screen.getByLabelText("New value");
    await user.clear(box);
    await user.type(box, "green");
    await user.click(screen.getByRole("button", { name: "Save" }));
    const table = screen.getByRole("table", { name: "Variables in dev" });
    await within(table).findByText("green");
  });

  test("a value passed down is overridden for the environment", async () => {
    const s = await scene();
    await s.put.org("REGION", "eu");
    mount(s.client);
    const region = await details("REGION");
    await userEvent
      .setup()
      .click(within(region).getByRole("button", { name: "Override REGION in dev" }));
    const form = screen.getByRole("form", { name: "Add a variable" });
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("REGION");
    expect(
      (within(form).getByLabelText("Applies to") as HTMLSelectElement).selectedOptions[0]?.text,
    ).toBe("Only dev");
  });

  test("it is deleted after asking, and the row and the details go", async () => {
    const s = await scene();
    await s.put.project("COLOR", "blue");
    await s.put.project("REGION", "eu");
    mount(s.client);
    const region = await details("COLOR");
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "Delete COLOR in dev" }));
    await user.click(
      within(screen.getByRole("alertdialog", { name: "Delete COLOR" })).getByRole("button", {
        name: "Delete variable",
      }),
    );
    // (no role query for the dialog, and a boolean, not a node: a failed `expect(node)` prints the whole page
    // on every poll and stalls the wait; the details have no heading any more, so the drawer going shows they went)
    await waitFor(() => expect(document.querySelector("dialog") === null).toBe(true));
    // the answer is a toast, since the drawer that would have held it is gone
    await waitFor(() =>
      expect(document.querySelector(".toast-text")?.textContent).toBe(
        "Deleted COLOR from the project.",
      ),
    );
    expect(document.querySelector(".toast-text")?.getAttribute("role")).toBe("status");
    expect(screen.queryAllByRole("region").length).toBe(1);
    const table = screen.getByRole("table", { name: "Variables in dev" });
    expect(within(table).queryByRole("button", { name: "COLOR" })).toBeNull();
    // its changes are not in the feed either
    await user.click(screen.getByRole("button", { name: "Changes" }));
    const changes = await screen.findByRole("dialog", { name: "Changes in dev" });
    await within(changes).findByText(/REGION/);
    expect(changes.textContent).not.toContain("COLOR");
    expect(within(table).getByRole("button", { name: "REGION" })).toBeTruthy();
  });

  test("Delete asks in a dialog over the details: Esc closes only the dialog, nothing goes, the focus comes back", async () => {
    const s = await scene();
    await s.put.project("DB_PASSWORD", SECRET, true);
    mount(s.client);
    const region = await details("DB_PASSWORD");
    const user = userEvent.setup();
    const button = within(region).getByRole("button", { name: "Delete DB_PASSWORD in dev" });
    await user.click(button);
    const ask = await screen.findByRole("alertdialog", { name: "Delete DB_PASSWORD" });
    expect(ask.textContent).toContain("Delete DB_PASSWORD from the project?");
    // the details stay behind it
    expect(screen.getByRole("dialog", { name: "DB_PASSWORD in dev" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("dialog", { name: "DB_PASSWORD in dev" })).toBeTruthy();
    expect(document.activeElement).toBe(button);
    expect(await s.audit("variable.delete")).toHaveLength(0);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("its history and its rotation open in the matrix's own components", async () => {
    const s = await scene();
    await s.put.project("DB_PASSWORD", SECRET, true);
    mount(s.client);
    const region = await details("DB_PASSWORD");
    const user = userEvent.setup();
    await user.click(within(region).getByRole("button", { name: "History of DB_PASSWORD in dev" }));
    expect(await screen.findByRole("region", { name: "History of DB_PASSWORD" })).toBeTruthy();
    await user.click(
      within(region).getByRole("button", { name: "Rotation of DB_PASSWORD in dev" }),
    );
    expect(await screen.findByRole("region", { name: "Rotation of DB_PASSWORD" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "History of DB_PASSWORD" })).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("a plain variable has no rotation button, as in the matrix", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const region = await details("REGION");
    expect(within(region).queryByRole("button", { name: /Rotation of/ })).toBeNull();
    expect(within(region).getByRole("button", { name: "History of REGION in dev" })).toBeTruthy();
  });
});
