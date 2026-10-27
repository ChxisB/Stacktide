import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";
import { openSecrets, SECRET, scene as sceneOn } from "./variables.fixture";

// VUI-11: the list has a select box on each variable and one in the header; with any selected a bar says how many
// and offers Delete selected, which lists what goes and from where, asks, and then calls the bulk route once for each
// level the variables are at. Not shown to a role that cannot delete.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);

type Bulk = { path: string; ops: { op: string; key: string }[]; dryRun?: boolean };

/** A client that keeps every bulk call, and can refuse the one whose path holds the text it is given. */
function watched(cookie: string) {
  const calls: Bulk[] = [];
  let refuse: string | undefined;
  const client = clientVia(backend.api, cookie, async (request, send) => {
    if (request.method === "POST" && pathOf(request).endsWith("/variables/bulk")) {
      calls.push({ path: pathOf(request), ...(await request.clone().json()) });
      if (refuse !== undefined && pathOf(request).includes(refuse))
        return down("another variable refers to it");
    }
    return send();
  });
  return {
    client,
    calls,
    refuse: (part: string | undefined) => {
      refuse = part;
    },
  };
}

/** One variable at each level: the environment's, the project's and the organization's. */
async function atEachLevel() {
  const s = await scene();
  await s.put.org("ORG_KEY", "o");
  await s.put.project("REGION", "eu");
  await s.put.env("dev", "API_KEY", SECRET, true);
  await s.put.env("dev", "PORT", "8080");
  return s;
}
const boxOf = (key: string) => screen.getByRole("checkbox", { name: `Select ${key}` });
const header = () => screen.getByRole("checkbox", { name: "Select all variables" });
const keysOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole("rowheader")
    .map((h) => h.textContent);
// a boolean, not toBeNull(): a failing check on an element prints the whole of it, which holds the page up while it waits
const closed = () =>
  waitFor(() =>
    expect(!!screen.queryByRole("dialog") || !!screen.queryByRole("alertdialog")).toBe(false),
  );
const bar = () => screen.queryByRole("group", { name: "Selected variables" });
const present = async (key: string) => {
  const table = screen.getByRole("table", { name: "Variables in dev" });
  return keysOf(table).some((k) => k?.includes(key));
};

describe("choosing rows", () => {
  test("each variable has a box and the header has one; the bar says how many and goes when none is left", async () => {
    const s = await atEachLevel();
    mount(s.client);
    const table = await openSecrets();
    expect(within(table).getAllByRole("checkbox")).toHaveLength(5);
    expect(!!bar()).toBe(false);
    const user = userEvent.setup();
    await user.click(boxOf("REGION"));
    const group = screen.getByRole("group", { name: "Selected variables" });
    expect(within(group).getByText("1 selected")).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Delete selected" })).toBeTruthy();
    await user.click(boxOf("PORT"));
    expect(within(group).getByText("2 selected")).toBeTruthy();
    await user.click(boxOf("REGION"));
    await user.click(boxOf("PORT"));
    expect(!!bar()).toBe(false);
  });

  test("the header box chooses every row, and a second press lets them all go; some chosen shows as part", async () => {
    const s = await atEachLevel();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(boxOf("PORT"));
    expect((header() as HTMLInputElement).indeterminate).toBe(true);
    await user.click(header());
    expect(
      within(screen.getByRole("group", { name: "Selected variables" })).getByText("4 selected"),
    ).toBeTruthy();
    expect((header() as HTMLInputElement).checked).toBe(true);
    await user.click(header());
    expect(!!bar()).toBe(false);
    expect((boxOf("API_KEY") as HTMLInputElement).checked).toBe(false);
  });

  test("a search narrows the rows, and the header and the bar are about the rows shown", async () => {
    const s = await atEachLevel();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search variables" }), "or");
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: "Select API_KEY" })).toBeNull(),
    );
    await user.click(header());
    // PORT and ORG_KEY hold "or" (REGION does not): only those are chosen
    expect(
      within(screen.getByRole("group", { name: "Selected variables" })).getByText("2 selected"),
    ).toBeTruthy();
  });

  test("a reporter sees no select boxes and no bar", async () => {
    const s = await scene({ reporter: true });
    await s.put.project("REGION", "eu");
    mount(s.client);
    const table = await openSecrets();
    expect(await within(table).findByText("REGION")).toBeTruthy();
    expect(within(table).queryAllByRole("checkbox")).toHaveLength(0);
    expect(!!bar()).toBe(false);
  });
});

describe("Delete selected", () => {
  test("it opens a confirm that lists every key and where each is deleted from, and cancel makes no request", async () => {
    const s = await atEachLevel();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const user = userEvent.setup();
    for (const key of ["API_KEY", "REGION", "ORG_KEY"]) await user.click(boxOf(key));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    const drawer = await screen.findByRole("alertdialog", { name: "Delete 3 variables" });
    const lines = within(within(drawer).getByRole("list"))
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(lines).toEqual([
      "API_KEY from this environment",
      "ORG_KEY from the organization",
      "REGION from the project",
    ]);
    await user.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await closed();
    expect(page.calls).toEqual([]);
    // what was chosen is still chosen
    expect(
      within(screen.getByRole("group", { name: "Selected variables" })).getByText("3 selected"),
    ).toBeTruthy();
    expect(await present("ORG_KEY")).toBe(true);
  });

  test("confirming makes one bulk call with exactly those keys, really applied, and the rows go", async () => {
    const s = await atEachLevel();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(boxOf("API_KEY"));
    await user.click(boxOf("PORT"));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    const drawer = await screen.findByRole("alertdialog", { name: "Delete 2 variables" });
    await user.click(within(drawer).getByRole("button", { name: "Delete variables" }));
    await closed();
    expect(page.calls).toEqual([
      {
        path: `/organizations/${s.org.id}/projects/${s.project.id}/environments/${s.envs.dev}/variables/bulk`,
        ops: [
          { op: "delete", key: "API_KEY" },
          { op: "delete", key: "PORT" },
        ],
        dryRun: false,
      },
    ]);
    await waitFor(async () => expect(await present("PORT")).toBe(false));
    expect(await present("API_KEY")).toBe(false);
    expect(await present("REGION")).toBe(true);
    expect(!!bar()).toBe(false);
    // the answer is a toast, with the sentence it had before
    await waitFor(() =>
      expect(document.querySelector(".toast-text")?.textContent).toBe("Deleted 2 variables."),
    );
    expect(document.querySelector(".toast-text")?.getAttribute("role")).toBe("status");
    expect(await s.audit("variable.bulk")).toHaveLength(1);
    expect(await s.audit("variable.delete")).toHaveLength(2);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("variables at three levels are three calls, the environment's first, each to its own level", async () => {
    const s = await atEachLevel();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(header());
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    const drawer = await screen.findByRole("alertdialog", { name: "Delete 4 variables" });
    await user.click(within(drawer).getByRole("button", { name: "Delete variables" }));
    await closed();
    const base = `/organizations/${s.org.id}`;
    expect(page.calls.map((c) => [c.path, c.ops.map((o) => o.key)])).toEqual([
      [
        `${base}/projects/${s.project.id}/environments/${s.envs.dev}/variables/bulk`,
        ["API_KEY", "PORT"],
      ],
      [`${base}/projects/${s.project.id}/variables/bulk`, ["REGION"]],
      [`${base}/variables/bulk`, ["ORG_KEY"]],
    ]);
    await screen.findByText("No variables in dev yet.");
  });
});

describe("a refusal", () => {
  test("shows its words, keeps the confirm, the choice and the rows, and a retry deletes", async () => {
    const s = await atEachLevel();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(boxOf("API_KEY"));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    page.refuse("/bulk"); // the first call is refused
    const drawer = await screen.findByRole("alertdialog", { name: "Delete 1 variable" });
    await user.click(within(drawer).getByRole("button", { name: "Delete variables" }));
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toContain("another variable refers to it");
    expect(alert.textContent).not.toContain(SECRET);
    expect(await present("API_KEY")).toBe(true);
    expect((boxOf("API_KEY") as HTMLInputElement).checked).toBe(true);
    expect(await s.audit("variable.delete")).toHaveLength(0);
    page.refuse(undefined);
    await user.click(within(drawer).getByRole("button", { name: "Delete variables" }));
    await closed();
    await waitFor(async () => expect(await present("API_KEY")).toBe(false));
    expect(page.calls).toHaveLength(2);
  });

  test("on a later level it says what was deleted and what was not, and a retry makes only the rest", async () => {
    const s = await atEachLevel();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.click(boxOf("API_KEY"));
    await user.click(boxOf("REGION"));
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    // the environment's call goes through, the project's is refused
    page.refuse(`/projects/${s.project.id}/variables/bulk`);
    const drawer = await screen.findByRole("alertdialog", { name: "Delete 2 variables" });
    await user.click(within(drawer).getByRole("button", { name: "Delete variables" }));
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toMatch(/^API_KEY was deleted; REGION was not: /);
    expect(alert.textContent).toContain("another variable refers to it");
    // the list is read again without what went, and the confirm is down to what is left
    await waitFor(async () => expect(await present("API_KEY")).toBe(false));
    expect(within(within(drawer).getByRole("list")).getAllByRole("listitem")).toHaveLength(1);
    page.refuse(undefined);
    await user.click(within(drawer).getByRole("button", { name: "Delete variables" }));
    await closed();
    expect(page.calls.map((c) => c.ops.map((o) => o.key))).toEqual([
      ["API_KEY"],
      ["REGION"],
      ["REGION"],
    ]);
    expect(await s.audit("variable.delete")).toHaveLength(2);
  });
});
