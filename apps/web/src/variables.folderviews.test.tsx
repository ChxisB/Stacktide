import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import {
  addNew,
  cellOf,
  markOf,
  must,
  openSecrets,
  SECRET,
  scene as sceneOn,
  showCompare,
  showEnvs,
} from "./variables.fixture";

// FLD-14: Compare environments, search, the history and rotation panels and the changes card know the open folder.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);
type Scene = Awaited<ReturnType<typeof scene>>;

async function folder(s: Scene, path: string) {
  const at = path.lastIndexOf("/");
  const parent = at === 0 ? "/" : path.slice(0, at);
  return must(await s.scope.folders.post({ parent, name: path.slice(at + 1) }));
}
/** A variable of the project in a folder, or of an environment when one is named. */
async function put(
  s: Scene,
  where: string,
  key: string,
  value: string,
  env?: string,
  secret = false,
) {
  const body = {
    key,
    kind: secret ? ("secret" as const) : ("plain" as const),
    value,
    folder: where,
  };
  return must(
    env
      ? await s.scope.environments({ envId: s.envs[env] ?? "" }).variables.post(body)
      : await s.scope.variables.post(body),
  );
}

/** A root variable and `/payments` with three of its own across the two environments. */
async function tree() {
  const s = await scene();
  await s.put.project("REGION", "eu");
  await folder(s, "/payments");
  await folder(s, "/search");
  await put(s, "/payments", "PAY_KEY", "k1");
  await put(s, "/payments", "PAY_URL", "https://pay.example", "dev");
  await put(s, "/payments", "PAY_STAGE", "only-staging", "staging");
  return s;
}

const matrix = () => screen.findByRole("table", { name: "Variables by environment" });
const keysOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole("rowheader")
    .map((h) => h.textContent);
const crumbs = () =>
  within(screen.getByRole("navigation", { name: "Folder path" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);
const open = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(await screen.findByRole("button", { name: `Open ${name}` }));
const search = (user: ReturnType<typeof userEvent.setup>, text: string) =>
  user.type(screen.getByRole("searchbox", { name: "Search variables" }), text);

describe("Compare environments in a folder", () => {
  test("the root's matrix holds the root's keys, with the folders as rows and the same breadcrumb", async () => {
    const s = await tree();
    mount(s.client);
    await showCompare();
    expect(keysOf(await matrix())).toEqual(["REGION"]);
    expect(crumbs()).toEqual(["acme/web", "dev, staging"]);
    const rows = await screen.findByRole("table", { name: "Folders in /" });
    expect(
      within(rows)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["payments", "search"]);
  });

  test("opening a folder in the matrix shows its keys across the environments and not the root's", async () => {
    const s = await tree();
    mount(s.client);
    await showCompare();
    await matrix();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toEqual(["acme/web", "dev, staging", "payments"]));
    const table = await matrix();
    await waitFor(() => expect(keysOf(table)).toEqual(["PAY_KEY", "PAY_STAGE", "PAY_URL"]));
    expect(markOf("PAY_KEY", "dev").textContent).toContain("From project");
    expect(markOf("PAY_URL", "dev").textContent).toContain("Set here");
    expect(markOf("PAY_URL", "staging").textContent).toContain("Not set");
    expect(markOf("PAY_STAGE", "dev").textContent).toContain("Not set");
    expect(markOf("PAY_STAGE", "staging").textContent).toContain("Set here");
    // the way back is the same breadcrumb
    await user.click(screen.getByRole("button", { name: "dev, staging" }));
    await waitFor(() =>
      expect(keysOf(screen.getByRole("table", { name: "Variables by environment" }))).toEqual([
        "REGION",
      ]),
    );
  });

  test("a folder with no variables says so in the matrix, and the root's keys are not shown there", async () => {
    const s = await tree();
    mount(s.client);
    await showCompare();
    await matrix();
    await open(userEvent.setup(), "search");
    expect(await screen.findByText("No variables in this folder")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Variables by environment" })).toBeNull();
    expect(screen.queryByText(/No variables yet/)).toBeNull();
  });

  test("the folder stays open when the page goes from one environment to the matrix and back", async () => {
    const s = await tree();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toEqual(["acme/web", "dev", "payments"]));
    await showCompare();
    await waitFor(() => expect(crumbs()).toEqual(["acme/web", "dev, staging", "payments"]));
    expect(keysOf(await matrix())).toEqual(["PAY_KEY", "PAY_STAGE", "PAY_URL"]);
  });

  test("Add a variable in the matrix makes it in the open folder, and says so", async () => {
    const s = await tree();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    await addNew(user, "Add a variable");
    const form = await screen.findByRole("form", { name: "Add a variable" });
    expect(within(form).getByText("/payments")).toBeTruthy();
    await user.type(within(form).getByLabelText("Name"), "PAY_NEW");
    await user.type(within(form).getByLabelText("Value"), "v1");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await waitFor(() =>
      expect(keysOf(screen.getByRole("table", { name: "Variables by environment" }))).toContain(
        "PAY_NEW",
      ),
    );
    const made = must(await s.scope.variables.get({ query: { limit: 100, folder: "/payments" } }));
    expect(made.items.map((v) => v.key)).toContain("PAY_NEW");
    const root = must(await s.scope.variables.get({ query: { limit: 100 } }));
    expect(root.items.map((v) => v.key)).toEqual(["REGION"]);
  });

  test("Download .env of a column is of the open folder", async () => {
    const s = await tree();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    const blobs: Blob[] = [];
    const make = URL.createObjectURL;
    URL.createObjectURL = (b: Blob | MediaSource) => {
      blobs.push(b as Blob);
      return "blob:folder";
    };
    try {
      await user.click(await screen.findByRole("button", { name: "Options for dev" }));
      await user.click(screen.getByRole("menuitem", { name: "Download .env" }));
      await screen.findByText(/^Downloaded acme-web-dev\.env: 2 variables/);
    } finally {
      URL.createObjectURL = make;
    }
    const text = await blobs[0]?.text();
    expect(text).toContain("PAY_KEY=");
    expect(text).toContain("PAY_URL=");
    expect(text).not.toContain("REGION");
  });
});

describe("the matrix of a folder keeps to it", () => {
  test("the quick add makes its variable in the open folder", async () => {
    const s = await tree();
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    await user.type(await screen.findByLabelText("Add a variable name"), "QUICK_ONE");
    await user.type(screen.getByLabelText("Add a variable value (applies to all)"), "q1");
    await user.click(await screen.findByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(keysOf(screen.getByRole("table", { name: "Variables by environment" }))).toContain(
        "QUICK_ONE",
      ),
    );
    // it makes one in each environment shown, all in the open folder
    for (const env of ["dev", "staging"]) {
      const at = s.scope.environments({ envId: s.envs[env] ?? "" }).variables;
      const there = must(await at.get({ query: { limit: 100, folder: "/payments" } }));
      expect(there.items.map((v) => v.key)).toContain("QUICK_ONE");
      const root = must(await at.get({ query: { limit: 100 } }));
      expect(root.items.map((v) => v.key)).not.toContain("QUICK_ONE");
    }
  });

  test("an override is of a variable of the same folder: the line says what it overrides", async () => {
    const s = await tree();
    // PAY_KEY is the project's in /payments; dev sets its own in /payments, and the root's PAY_KEY is another variable
    await put(s, "/payments", "PAY_KEY", "dev-k", "dev");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    await waitFor(() =>
      expect(keysOf(screen.getByRole("table", { name: "Variables by environment" }))).toContain(
        "PAY_KEY",
      ),
    );
    expect(cellOf("PAY_KEY", "dev").textContent).toContain("Overrides project");
    expect(cellOf("PAY_KEY", "staging").textContent).toContain("From project");
  });

  test("an open row is not carried into another folder, where the same key is another variable", async () => {
    const s = await tree();
    await folder(s, "/other");
    await put(s, "/other", "PAY_KEY", "k2");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    await waitFor(() =>
      expect(keysOf(screen.getByRole("table", { name: "Variables by environment" }))).toContain(
        "PAY_KEY",
      ),
    );
    await user.click(within(await matrix()).getByRole("button", { name: "PAY_KEY" }));
    expect(
      within(await matrix())
        .getByRole("button", { name: "PAY_KEY" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    await user.click(screen.getByRole("button", { name: "dev, staging" }));
    await open(user, "other");
    await waitFor(() => expect(crumbs()).toContain("other"));
    const key = await within(await matrix()).findByRole("button", { name: "PAY_KEY" });
    expect(key.getAttribute("aria-expanded")).toBe("false");
  });

  test("a folder that went while it was open: the matrix returns to the nearest one that is still there", async () => {
    const s = await sceneOn(backend, { environments: ["dev", "staging", "qa"] });
    await s.put.project("REGION", "eu");
    await folder(s, "/a");
    const inner = await folder(s, "/a/b");
    mount(s.client);
    await showEnvs("dev", "staging");
    const user = userEvent.setup();
    await open(user, "a");
    await open(user, "b");
    await waitFor(() => expect(crumbs()).toEqual(["acme/web", "dev, staging", "a", "b"]));
    // gone in another window; the page finds out the next time it reads
    must(await s.scope.folders({ folderId: inner.id }).delete());
    await showEnvs("dev", "qa");
    await waitFor(() => expect(crumbs()).toEqual(["acme/web", "dev, qa", "a"]));
  });
});

describe("search in a folder", () => {
  test("the list finds a key of the open folder and not one of the root", async () => {
    const s = await tree();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    await search(user, "PAY_U");
    const table = await screen.findByRole("table", { name: "Variables in dev" });
    expect(keysOf(table)).toEqual(["PAY_URL"]);
    await user.clear(screen.getByRole("searchbox", { name: "Search variables" }));
    await search(user, "REGION");
    expect(await screen.findByText("No variables match “REGION”.")).toBeTruthy();
    // and the other way: in the root, a key of the folder is not found
    await user.click(screen.getByRole("button", { name: "dev" }));
    await waitFor(() => expect(crumbs()).toEqual(["acme/web", "dev"]));
    expect(await screen.findByRole("table", { name: "Variables in dev" })).toBeTruthy();
    await user.clear(screen.getByRole("searchbox", { name: "Search variables" }));
    await search(user, "PAY_URL");
    expect(await screen.findByText("No variables match “PAY_URL”.")).toBeTruthy();
  });

  test("the matrix does the same, and the search is kept when the folder changes", async () => {
    const s = await tree();
    mount(s.client);
    await showCompare();
    await matrix();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    await search(user, "PAY_S");
    await waitFor(() =>
      expect(keysOf(screen.getByRole("table", { name: "Variables by environment" }))).toEqual([
        "PAY_STAGE",
      ]),
    );
    await user.clear(screen.getByRole("searchbox", { name: "Search variables" }));
    await search(user, "REGION");
    expect(await screen.findByText("No variables match “REGION”.")).toBeTruthy();
  });
});

describe("history and rotation name the folder", () => {
  test("the history of a variable of /payments says so; a root variable's says nothing", async () => {
    const s = await tree();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    const root = await screen.findByRole("table", { name: "Variables in dev" });
    await user.click(within(root).getByRole("button", { name: "REGION" }));
    await user.click(await screen.findByRole("button", { name: "History of REGION in dev" }));
    const rootHistory = await screen.findByRole("region", { name: "History of REGION" });
    expect(rootHistory.textContent).not.toContain("In folder");
    await user.keyboard("{Escape}");
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    const table = await screen.findByRole("table", { name: "Variables in dev" });
    await user.click(within(table).getByRole("button", { name: "PAY_KEY" }));
    await user.click(await screen.findByRole("button", { name: "History of PAY_KEY in dev" }));
    const history = await screen.findByRole("region", { name: "History of PAY_KEY" });
    expect(within(history).getByText("/payments")).toBeTruthy();
    expect(history.textContent).toContain("In folder");
  });

  test("the rotation panel of a secret of /payments says so", async () => {
    const s = await tree();
    await put(s, "/payments", "PAY_SECRET", SECRET, undefined, true);
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    const table = await screen.findByRole("table", { name: "Variables in dev" });
    await user.click(within(table).getByRole("button", { name: "PAY_SECRET" }));
    await user.click(await screen.findByRole("button", { name: "Rotation of PAY_SECRET in dev" }));
    const rotation = await screen.findByRole("region", { name: "Rotation of PAY_SECRET" });
    expect(within(rotation).getByText("/payments")).toBeTruthy();
    expect(rotation.textContent).not.toContain(SECRET);
  });

  test("the matrix's history of a line says the folder too", async () => {
    const s = await tree();
    mount(s.client);
    await showCompare();
    await matrix();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    await waitFor(() =>
      expect(keysOf(screen.getByRole("table", { name: "Variables by environment" }))).toContain(
        "PAY_URL",
      ),
    );
    await user.click(
      within(cellOf("PAY_URL", "dev")).getByRole("button", {
        name: "More actions for PAY_URL in dev",
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Version history" }));
    const history = await screen.findByRole("region", { name: "History of PAY_URL" });
    expect(within(history).getByText("/payments")).toBeTruthy();
  });
});

describe("the changes card", () => {
  async function twoUrls() {
    const s = await scene();
    await folder(s, "/payments");
    await put(s, "/", "URL", "https://root.example", "dev");
    await put(s, "/payments", "URL", "https://pay.example", "dev");
    await put(s, "/payments", "TOKEN", "t1", "dev");
    return s;
  }
  const card = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole("button", { name: "Changes" }));
    return screen.findByRole("dialog", { name: "Changes in dev" });
  };
  const rowsOf = (dialog: HTMLElement) =>
    within(dialog)
      .getAllByRole("listitem")
      .map((li) => (li.textContent ?? "").replace(/\s+/g, " "));

  test("a change in a folder shows the folder next to the key; a root change shows none", async () => {
    const s = await twoUrls();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    const dialog = await card(user);
    await waitFor(() => expect(rowsOf(dialog).length).toBe(3));
    const rows = rowsOf(dialog);
    expect(rows.find((r) => r.includes("TOKEN"))).toMatch(
      /changed TOKEN in \/payments to version 1/,
    );
    const rootUrl = rows.find((r) => /URL/.test(r) && !r.includes("/payments"));
    expect(rootUrl).toMatch(/changed URL to version 1/);
    expect(rows.filter((r) => r.includes("/payments"))).toHaveLength(2);
  });

  test("a change of the other folder's URL does not open the root's URL", async () => {
    const s = await twoUrls();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    const dialog = await card(user);
    await waitFor(() => expect(rowsOf(dialog).length).toBe(3));
    // the root has a URL, so its change is a button; the /payments ones are not: that folder is not the open one
    expect(within(dialog).getAllByRole("button", { name: "URL" })).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: "TOKEN" })).toBeNull();
  });

  test("inside /payments its own changes open the details", async () => {
    const s = await twoUrls();
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await open(user, "payments");
    await waitFor(() => expect(crumbs()).toContain("payments"));
    const dialog = await card(user);
    await user.click(await within(dialog).findByRole("button", { name: "TOKEN" }));
    expect(await screen.findByRole("dialog", { name: "TOKEN in dev" })).toBeTruthy();
    expect(
      within(await screen.findByRole("region", { name: "TOKEN" })).getByText("t1"),
    ).toBeTruthy();
  });

  test("the matrix's card does the same", async () => {
    const s = await twoUrls();
    mount(s.client);
    await showCompare();
    await matrix();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Options for dev" }));
    await user.click(screen.getByRole("menuitem", { name: "View changes" }));
    const dialog = await screen.findByRole("dialog", { name: "Changes in dev" });
    await waitFor(() => expect(rowsOf(dialog).length).toBe(3));
    expect(rowsOf(dialog).filter((r) => r.includes("/payments"))).toHaveLength(2);
    expect(within(dialog).getAllByRole("button", { name: "URL" })).toHaveLength(1);
  });
});
