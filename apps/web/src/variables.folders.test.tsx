import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createProject } from "@orch/db";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import {
  addNew,
  must,
  openSecrets,
  rowOf,
  SECRET,
  scene as sceneOn,
  showEnvs,
} from "./variables.fixture";

// FLD-11: the Secrets view opens a folder: a breadcrumb, the folder's sub-folders as rows, its variables.

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
async function put(s: Scene, where: string, key: string, value: string, env?: string) {
  const body = { key, kind: "plain" as const, value, folder: where };
  must(
    env
      ? await s.scope.environments({ envId: s.envs[env] ?? "" }).variables.post(body)
      : await s.scope.variables.post(body),
  );
}

const crumbs = () => screen.getByRole("navigation", { name: "Folder path" });
const folders = (where = "/") => screen.findByRole("table", { name: `Folders in ${where}` });
const names = (table: HTMLElement) =>
  within(table)
    .getAllByRole("rowheader")
    .map((h) => h.textContent);
const variablesIn = (table: HTMLElement) =>
  within(table)
    .getAllByRole("rowheader")
    .map((h) => h.textContent);
// the folders are read after the variables, so a row's button may not be there yet
const open = async (user: ReturnType<typeof userEvent.setup>, name: string) =>
  user.click(await screen.findByRole("button", { name: `Open ${name}` }));

async function tree() {
  const s = await scene();
  await s.put.project("REGION", "eu");
  await folder(s, "/payments");
  await folder(s, "/payments/eu");
  await folder(s, "/search");
  await put(s, "/payments", "PAY_KEY", "k1");
  await put(s, "/payments", "PAY_URL", "https://pay.example", "dev");
  await put(s, "/payments", "PAY_STAGE", "only-staging", "staging");
  await put(s, "/payments/eu", "EU_ONLY", "yes");
  return s;
}

describe("the root", () => {
  test("shows its folders as rows (name, how many variables, Open) above the variables at the root", async () => {
    const s = await tree();
    mount(s.client);
    const list = await openSecrets();
    expect(variablesIn(list)).toEqual(["REGION"]);
    const table = await folders();
    // the direct folders only: /payments/eu is inside payments
    expect(names(table)).toEqual(["payments", "search"]);
    const [payments, search] = within(table).getAllByRole("row").slice(1);
    // the count is what the folder holds at every level (it is what keeps a delete away), not only this environment
    expect(within(payments as HTMLElement).getByText("3 variables")).toBeTruthy();
    expect(within(search as HTMLElement).getByText("0 variables")).toBeTruthy();
    expect(
      within(payments as HTMLElement).getByRole("button", { name: "Open payments" }),
    ).toBeTruthy();
    expect(table.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("a project with no folder shows none, and the list is as it was", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    expect(screen.queryByRole("table", { name: /^Folders in/ })).toBeNull();
    expect(
      within(crumbs())
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["acme/web", "dev"]);
  });

  test("a reporter, who reads variables, sees the folders too", async () => {
    const s = await scene({ reporter: true });
    must(
      await s.admin.client
        .organizations({ orgId: s.org.id })
        .projects({ projectId: s.project.id })
        .folders.post({ name: "payments" }),
    );
    mount(s.client);
    expect(names(await folders())).toEqual(["payments"]);
  });
});

describe("opening a folder", () => {
  test("lists its variables and not the root's, and its own folders", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    await waitFor(() => expect(screen.queryByText("REGION") === null).toBe(true));
    const list = await screen.findByRole("table", { name: "Variables in dev" });
    // in dev: the project's PAY_KEY and dev's PAY_URL; staging's value is not here
    expect(variablesIn(list)).toEqual(["PAY_KEY", "PAY_URL"]);
    const inner = await folders("/payments");
    expect(names(inner)).toEqual(["eu"]);
    expect(within(inner).getByText("1 variable")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Folders in /" })).toBeNull();
  });

  test("a variable deleted in a folder is no longer counted by the folder's row", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    await screen.findByRole("table", { name: "Variables in dev" });
    await user.click(screen.getByRole("button", { name: "More actions for PAY_KEY" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    const form = await screen.findByRole("form", { name: "Delete PAY_KEY" });
    await user.click(within(form).getByRole("button", { name: "Delete variable" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "PAY_KEY" }) === null).toBe(true),
    );
    await user.click(within(crumbs()).getByRole("button", { name: "dev" }));
    const root = await folders();
    // the row is read again, not served from before the delete
    await waitFor(() => expect(within(root).getByText("2 variables")).toBeTruthy());
  });

  test("the breadcrumb names the project, the environment and each folder; the last is the page, not a link", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    await folders("/payments");
    await open(user, "eu");
    await screen.findByText("EU_ONLY");
    const bar = within(crumbs());
    expect(bar.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "acme/web",
      "dev",
      "payments",
      "eu",
    ]);
    const here = bar.getByText("eu");
    expect(
      here.closest("li")?.getAttribute("aria-current") ?? here.getAttribute("aria-current"),
    ).toBe("page");
    expect(bar.queryByRole("button", { name: "eu" })).toBeNull();
    expect(bar.getByRole("button", { name: "payments" })).toBeTruthy();
    expect(bar.getByRole("button", { name: "dev" })).toBeTruthy();
  });

  test("the breadcrumb goes up one level, and to the root", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    await folders("/payments");
    await open(user, "eu");
    await waitFor(() =>
      expect(variablesIn(screen.getByRole("table", { name: "Variables in dev" }))).toEqual([
        "EU_ONLY",
      ]),
    );

    await user.click(within(crumbs()).getByRole("button", { name: "payments" }));
    await waitFor(() =>
      expect(variablesIn(screen.getByRole("table", { name: "Variables in dev" }))).toEqual([
        "PAY_KEY",
        "PAY_URL",
      ]),
    );
    expect(within(crumbs()).queryByRole("button", { name: "payments" })).toBeNull();

    await user.click(within(crumbs()).getByRole("button", { name: "dev" }));
    await waitFor(() =>
      expect(variablesIn(screen.getByRole("table", { name: "Variables in dev" }))).toEqual([
        "REGION",
      ]),
    );
    expect(names(await folders())).toEqual(["payments", "search"]);
    // at the root the environment is the page
    expect(within(crumbs()).queryByRole("button")).toBeNull();
  });

  test("a folder without variables says so, and the toolbar still offers Add", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "search");
    await screen.findByText("No variables in this folder");
    expect(screen.queryByText(/No variables in dev yet/)).toBeNull();
    expect(screen.queryByRole("table", { name: "Variables in dev" })).toBeNull();
    await addNew(user, "Add a variable");
    expect(await screen.findByRole("form", { name: "Add a variable" })).toBeTruthy();
  });

  test("the root without variables still says it as before, and shows its folders", async () => {
    const s = await scene();
    await folder(s, "/payments");
    mount(s.client);
    await screen.findByText("No variables in dev yet.");
    expect(names(await folders())).toEqual(["payments"]);
  });

  test("another environment keeps the folder: the tree is the project's, and its variables are the environment's", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    await folders("/payments");
    await showEnvs("staging");
    const list = await screen.findByRole("table", { name: "Variables in staging" });
    expect(variablesIn(list)).toEqual(["PAY_KEY", "PAY_STAGE"]);
    expect(
      within(crumbs())
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["acme/web", "staging", "payments"]);
  });

  test("another project starts at the root, with its own folders", async () => {
    const s = await tree();
    const other = await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/api" });
    const there = s.client.organizations({ orgId: s.org.id }).projects({ projectId: other.id });
    must(await there.environments.post({ name: "dev", slug: "dev" }));
    must(await there.folders.post({ name: "queues" }));
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    await folders("/payments");
    await user.selectOptions(screen.getByLabelText("Project"), "acme/api");
    expect(names(await folders())).toEqual(["queues"]);
    expect(
      within(crumbs())
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["acme/api", "dev"]);
  });
});

describe("what one folder's list leaves behind", () => {
  test("opening a folder drops what was revealed and ticked at the root, though a key of the same name is there", async () => {
    const s = await scene();
    await folder(s, "/payments");
    await s.put.project("TOKEN", "root-token-9f2c", true);
    must(
      await s.scope.variables.post({
        key: "TOKEN",
        kind: "secret",
        value: "folder-token-77ab",
        folder: "/payments",
      }),
    );
    mount(s.client);
    const user = userEvent.setup();
    const list = await openSecrets();
    await user.click(within(list).getByRole("checkbox", { name: "Select TOKEN" }));
    await user.click(screen.getByRole("button", { name: "Reveal all" }));
    await screen.findByText("root-token-9f2c");
    expect(screen.getByText("1 selected")).toBeTruthy();

    await open(user, "payments");
    const inside = await screen.findByRole("table", { name: "Variables in dev" });
    await within(inside).findByRole("button", { name: "TOKEN" });
    expect(document.body.textContent).not.toContain("root-token-9f2c");
    expect(screen.getByRole("button", { name: "Reveal all" })).toBeTruthy();
    expect(
      (within(inside).getByRole("checkbox", { name: "Select TOKEN" }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(screen.queryByText("1 selected")).toBeNull();
  });
});

describe("what a folder row and a folder's list hold", () => {
  test("a secret in a folder is masked in the list, and no value is on a folder row or in the breadcrumb", async () => {
    const s = await scene();
    await folder(s, "/vault");
    must(
      await s.scope.variables.post({
        key: "VAULT_KEY",
        kind: "secret",
        value: SECRET,
        folder: "/vault",
      }),
    );
    mount(s.client);
    const user = userEvent.setup();
    await folders();
    await open(user, "vault");
    const list = await screen.findByRole("table", { name: "Variables in dev" });
    expect(within(rowOf(list, "VAULT_KEY")[0] as HTMLElement).queryByText(SECRET)).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("an environment's value in a folder overrides the project's in that folder, not another folder's and not an organization's", async () => {
    const s = await scene();
    await folder(s, "/payments");
    await s.put.org("RATE", "org");
    await put(s, "/payments", "RATE", "dev", "dev");
    await put(s, "/payments", "LIMIT", "project");
    await put(s, "/payments", "LIMIT", "dev", "dev");
    await put(s, "/payments", "ROOT_ONLY", "dev", "dev");
    await put(s, "/", "ROOT_ONLY", "root-project");
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    const list = await screen.findByRole("table", { name: "Variables in dev" });
    await within(list).findByRole("button", { name: "LIMIT" });
    const says = async (key: string) => {
      await user.click(within(list).getByRole("button", { name: key }));
      const region = await screen.findByRole("region", { name: key });
      await within(region).findByText("Version");
      return region.textContent ?? "";
    };
    expect(await says("LIMIT")).toContain("Overrides the Project value");
    // the project's ROOT_ONLY is another variable, in another folder; the organization's RATE is at the root
    expect(await says("ROOT_ONLY")).not.toContain("Overrides");
    expect(await says("RATE")).not.toContain("Overrides");
  });
});

// FLD-12: make, rename and delete a folder on the page; Add variable, Import and the quick add act on the open folder.

const paths = async (s: Scene) =>
  must(await s.scope.folders.get())
    .items.map((f) => f.path)
    .sort();
const press = (name: string) => screen.findByRole("button", { name });
/** What the variables of one environment hold in a folder, by name. */
const keysIn = async (s: Scene, where: string, env = "dev") =>
  must(
    await s.scope
      .environments({ envId: s.envs[env] ?? "" })
      .variables.get({ query: { limit: 100, folder: where } }),
  )
    .items.map((v) => v.key)
    .sort();
const projectKeysIn = async (s: Scene, where: string) =>
  must(await s.scope.variables.get({ query: { limit: 100, folder: where } }))
    .items.map((v) => v.key)
    .sort();

describe("making a folder", () => {
  test("Add folder makes one in the open folder, and its row is there without a reload", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await user.click(await press("Add folder"));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    expect(within(dialog).getByText("/")).toBeTruthy();
    await user.type(within(dialog).getByLabelText("Folder name"), "payments");
    await user.click(within(dialog).getByRole("button", { name: "Add folder" }));
    expect(names(await folders())).toEqual(["payments"]);
    expect(screen.queryByRole("dialog")).toBeNull();
    // and the next one is made in the folder that is open now
    await open(user, "payments");
    await user.click(await press("Add folder"));
    const again = await screen.findByRole("dialog", { name: "New folder" });
    expect(within(again).getByText("/payments")).toBeTruthy();
    await user.type(within(again).getByLabelText("Folder name"), "eu");
    await user.click(within(again).getByRole("button", { name: "Add folder" }));
    expect(names(await folders("/payments"))).toEqual(["eu"]);
    expect(await paths(s)).toEqual(["/payments", "/payments/eu"]);
  });

  test("a name that is not allowed is refused, saying what is, and nothing is made", async () => {
    const s = await scene();
    await folder(s, "/payments");
    mount(s.client);
    const user = userEvent.setup();
    await folders();
    await user.click(await press("Add folder"));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    await user.type(within(dialog).getByLabelText("Folder name"), "Pay Ments");
    await user.click(within(dialog).getByRole("button", { name: "Add folder" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("lower-case letters, digits, - or _");
    expect(alert.textContent).toContain("32");
    expect(await paths(s)).toEqual(["/payments"]);
    // the form stays, with what was typed
    expect((within(dialog).getByLabelText("Folder name") as HTMLInputElement).value).toBe(
      "Pay Ments",
    );
  });

  test("a name that is taken is refused with the API's words", async () => {
    const s = await scene();
    await folder(s, "/payments");
    mount(s.client);
    const user = userEvent.setup();
    await folders();
    await user.click(await press("Add folder"));
    const dialog = await screen.findByRole("dialog", { name: "New folder" });
    await user.type(within(dialog).getByLabelText("Folder name"), "payments");
    await user.click(within(dialog).getByRole("button", { name: "Add folder" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("already in use");
    expect(await paths(s)).toEqual(["/payments"]);
  });
});

describe("renaming and deleting a folder", () => {
  test("Rename changes the name on its row, in its folders' paths and in the breadcrumb of what is opened after", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await user.click(await press("Rename payments"));
    const dialog = await screen.findByRole("dialog", { name: "Rename payments" });
    const box = within(dialog).getByLabelText("Folder name") as HTMLInputElement;
    expect(box.value).toBe("payments");
    await user.clear(box);
    await user.type(box, "pay");
    await user.click(within(dialog).getByRole("button", { name: "Rename folder" }));
    await waitFor(() =>
      expect(names(screen.getByRole("table", { name: "Folders in /" }))).toEqual(["pay", "search"]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await paths(s)).toEqual(["/pay", "/pay/eu", "/search"]);
    await open(user, "pay");
    const list = await screen.findByRole("table", { name: "Variables in dev" });
    expect(variablesIn(list)).toEqual(["PAY_KEY", "PAY_URL"]);
    expect(names(await folders("/pay"))).toEqual(["eu"]);
    expect(
      within(crumbs())
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["acme/web", "dev", "pay"]);
  });

  test("Rename with a name that is not allowed or taken says why and changes nothing", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await user.click(await press("Rename payments"));
    const dialog = await screen.findByRole("dialog", { name: "Rename payments" });
    const box = within(dialog).getByLabelText("Folder name");
    await user.clear(box);
    await user.type(box, "UPPER");
    await user.click(within(dialog).getByRole("button", { name: "Rename folder" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("lower-case");
    await user.clear(box);
    await user.type(box, "search");
    await user.click(within(dialog).getByRole("button", { name: "Rename folder" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toContain("already in use"),
    );
    expect(await paths(s)).toEqual(["/payments", "/payments/eu", "/search"]);
  });

  test("Delete removes an empty folder, and its row goes", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await user.click(await press("Delete search"));
    const dialog = await screen.findByRole("dialog", { name: "Delete search" });
    await user.click(within(dialog).getByRole("button", { name: "Delete folder" }));
    await waitFor(() =>
      expect(names(screen.getByRole("table", { name: "Folders in /" }))).toEqual(["payments"]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await paths(s)).toEqual(["/payments", "/payments/eu"]);
  });

  test("Delete of a folder that is not empty shows the API's message and changes nothing", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await user.click(await press("Delete payments"));
    const dialog = await screen.findByRole("dialog", { name: "Delete payments" });
    await user.click(within(dialog).getByRole("button", { name: "Delete folder" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("empty it first");
    expect(await paths(s)).toEqual(["/payments", "/payments/eu", "/search"]);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const table = await folders();
    expect(within(table).getByText("3 variables")).toBeTruthy();
  });

  test("a folder that went while it was open: the page returns to the nearest one that is still there", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    await folder(s, "/a");
    const inner = await folder(s, "/a/b");
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "a");
    await folders("/a");
    await open(user, "b");
    await screen.findByText("No variables in this folder");
    // gone in another window; the page finds out the next time it reads
    must(await s.scope.folders({ folderId: inner.id }).delete());
    await showEnvs("staging");
    await waitFor(() =>
      expect(
        within(crumbs())
          .getAllByRole("listitem")
          .map((li) => li.textContent),
      ).toEqual(["acme/web", "staging", "a"]),
    );
    expect(await screen.findByText("No variables in this folder")).toBeTruthy();
  });
});

describe("what Add variable, Import and the quick add do in a folder", () => {
  test("Add variable in /payments makes it there, says so, and the root does not get it", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    await screen.findByRole("table", { name: "Variables in dev" });
    await addNew(user, "Add a variable");
    const form = await screen.findByRole("form", { name: "Add a variable" });
    expect(within(form).getByText("/payments")).toBeTruthy();
    // an organization's variables sit at the root: not offered inside a folder
    expect(
      within(form).queryByRole("option", { name: /Every project of the organization/ }),
    ).toBeNull();
    await user.type(within(form).getByLabelText("Name"), "NEW_ONE");
    await user.type(within(form).getByLabelText("Value"), "v1");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    const list = await screen.findByRole("table", { name: "Variables in dev" });
    await within(list).findByRole("rowheader", { name: "NEW_ONE" });
    expect(await keysIn(s, "/payments")).toContain("NEW_ONE");
    expect(await keysIn(s, "/")).not.toContain("NEW_ONE");
    expect(await projectKeysIn(s, "/")).not.toContain("NEW_ONE");
    // at the root, the option is there again
    await user.click(within(crumbs()).getByRole("button", { name: "dev" }));
    await folders();
    await addNew(user, "Add a variable");
    const root = await screen.findByRole("form", { name: "Add a variable" });
    expect(
      within(root).getByRole("option", { name: /Every project of the organization/ }),
    ).toBeTruthy();
    expect(within(root).queryByText("/payments")).toBeNull();
  });

  test("Import in /payments brings the variables into it, and nothing into the root", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    await screen.findByRole("table", { name: "Variables in dev" });
    await addNew(user, "Import variables");
    const form = await screen.findByRole("form", { name: "Import variables" });
    expect(within(form).getByText("/payments")).toBeTruthy();
    expect(
      within(form).queryByRole("option", { name: /Every project of the organization/ }),
    ).toBeNull();
    await user.click(within(form).getByLabelText("Text to import"));
    await user.paste("IMPORTED=1");
    await user.click(within(form).getByRole("button", { name: "Preview" }));
    await user.click(await within(form).findByRole("button", { name: "Apply import" }));
    await within(form).findByText(/1 created/);
    expect(await projectKeysIn(s, "/payments")).toContain("IMPORTED");
    expect(await projectKeysIn(s, "/")).not.toContain("IMPORTED");
  });

  test("Import at the root names no folder and still offers the organization", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await addNew(user, "Import variables");
    const form = await screen.findByRole("form", { name: "Import variables" });
    expect(within(form).queryByText(/They go into/)).toBeNull();
    expect(
      within(form).getByRole("option", { name: /Every project of the organization/ }),
    ).toBeTruthy();
  });

  test("the quick add makes its secret in the open folder", async () => {
    const s = await tree();
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await open(user, "payments");
    await screen.findByRole("table", { name: "Variables in dev" });
    await user.type(screen.getByLabelText("Add a variable name"), "QUICK_ONE");
    await user.type(screen.getByLabelText("Add a variable value"), "q1");
    await user.click(await press("Add"));
    const list = await screen.findByRole("table", { name: "Variables in dev" });
    await within(list).findByRole("rowheader", { name: "QUICK_ONE" });
    expect(await keysIn(s, "/payments")).toContain("QUICK_ONE");
    expect(await keysIn(s, "/")).not.toContain("QUICK_ONE");
  });
});
