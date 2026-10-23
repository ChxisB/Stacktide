import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";
import { SECRET, scene as sceneOn, showCompare, showSecrets } from "./variables.fixture";

// VUI-17: the matrix has the list's toolbar (search, tag filter, Add New), a last row that makes a secret in every
// environment shown, and a count at its foot. The two buttons under it are gone.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);

/** A client that keeps every create, and can refuse one in the environment whose path it is given. */
function watched(cookie: string) {
  const creates: string[] = [];
  let refuse: string | undefined;
  const client = clientVia(backend.api, cookie, async (request, send) => {
    if (request.method === "POST" && /\/variables$/.test(pathOf(request))) {
      creates.push(pathOf(request));
      if (refuse && pathOf(request).includes(refuse)) return down("the environment is busy");
    }
    return send();
  });
  return {
    client,
    creates,
    refuse: (part: string | undefined) => {
      refuse = part;
    },
  };
}

/** Dev and staging, three keys: one with a tag, one a plain value that is searched, one only staging has. */
async function withKeys() {
  const s = await scene();
  await s.scope.variables.post({
    key: "API_URL",
    kind: "plain",
    value: "api.example.test",
    tags: ["web"],
  });
  await s.put.project("REGION", "eu");
  await s.put.env("staging", "ONLY_STAGING", "x");
  return s;
}
const matrix = async () => {
  await showCompare();
  return screen.findByRole("table", { name: "Variables by environment" });
};
const keysOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole("rowheader")
    .map((h) => h.textContent);
const nameBox = () => screen.getByLabelText("Add a variable name") as HTMLInputElement;
const valueBox = () =>
  screen.getByLabelText("Add a variable value (applies to all)") as HTMLInputElement;
const count = () => screen.getByText(/^\d+( of \d+)? variables?$/).textContent;

describe("the toolbar", () => {
  test("it has the search, the tag filter and Add New, and the two buttons under the matrix are gone", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    expect(screen.getByRole("searchbox", { name: "Search variables" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Filter/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add New" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a variable" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import variables" })).toBeNull();
  });

  test("Add New does the work of the two buttons: a Create drawer and an Import drawer", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add New" }));
    await user.click(screen.getByRole("menuitem", { name: "Add a variable" }));
    const create = await screen.findByRole("dialog", { name: "New variable" });
    expect(within(create).getByRole("form", { name: "Add a variable" })).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Add New" }));
    await user.click(screen.getByRole("menuitem", { name: "Import variables" }));
    const imports = await screen.findByRole("dialog");
    expect(within(imports).getByRole("form", { name: "Import variables" })).toBeTruthy();
  });

  test("a search hides the keys that do not match, in every environment, and the count says how many are left", async () => {
    const s = await withKeys();
    mount(s.client);
    const table = await matrix();
    expect(keysOf(table)).toHaveLength(3);
    expect(count()).toBe("3 variables");
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search variables" }), "reg");
    await waitFor(() => expect(keysOf(table)).toEqual(["REGION"]));
    expect(count()).toBe("1 of 3 variables");
    // a plain value is searched as the list does; a key that only staging has is found by its name
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "example.test");
    await waitFor(() => expect(keysOf(table)).toEqual(["API_URL"]));
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "only_");
    await waitFor(() => expect(keysOf(table)).toEqual(["ONLY_STAGING"]));
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "nothing like it");
    expect(await screen.findByText("No variables match “nothing like it”.")).toBeTruthy();
  });

  test("the tag filter lists the tags of every environment shown and narrows the matrix to one", async () => {
    const s = await withKeys();
    mount(s.client);
    const table = await matrix();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Filter/ }));
    const select = screen.getByLabelText("Tag") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.text)).toEqual(["All tags", "web"]);
    await user.selectOptions(select, "web");
    await waitFor(() => expect(keysOf(table)).toEqual(["API_URL"]));
    expect(count()).toBe("1 of 3 variables");
  });

  test("the search and the tag are kept when the matrix goes back to one environment and returns", async () => {
    const s = await withKeys();
    mount(s.client);
    await matrix();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search variables" }), "reg");
    await waitFor(() => expect(count()).toBe("1 of 3 variables"));
    await showSecrets("dev");
    await screen.findByRole("table", { name: "Variables in dev" });
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("reg");
  });
});

describe("the last row", () => {
  test("it is the last thing in the card, below the matrix and its count, with masked fields named for what they do", async () => {
    const s = await withKeys();
    mount(s.client);
    const table = await matrix();
    const form = screen.getByRole("form", { name: "Quick add" });
    expect(table.contains(form)).toBe(false);
    expect(table.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nameBox().placeholder).toBe("Add a variable name");
    expect(valueBox().type).toBe("password");
    expect(valueBox().placeholder).toBe("Value (applies to all)");
  });

  test("Enter makes the secret in every environment shown, one create each, and the matrix shows it in both", async () => {
    const s = await withKeys();
    const page = watched(s.cookie);
    mount(page.client);
    const table = await matrix();
    const user = userEvent.setup();
    await user.type(nameBox(), "NEW_KEY");
    await user.type(valueBox(), `${SECRET}{Enter}`);
    await waitFor(() => expect(keysOf(table)).toContain("NEW_KEY"));
    expect(page.creates.map((p) => p.split("/environments/")[1])).toEqual([
      `${s.envs.dev}/variables`,
      `${s.envs.staging}/variables`,
    ]);
    const row = within(table)
      .getByRole("rowheader", { name: /NEW_KEY/ })
      .closest("tr");
    expect(within(row as HTMLElement).getAllByText("Set here")).toHaveLength(2);
    expect(await s.audit("variable.create")).toHaveLength(5);
    // the row clears, and the secret is nowhere on the page
    await waitFor(() => expect(nameBox().value).toBe(""));
    expect(valueBox().value).toBe("");
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("the second refused says which was made and which was not, keeps the first, and a retry makes only the other", async () => {
    const s = await withKeys();
    const page = watched(s.cookie);
    mount(page.client);
    const table = await matrix();
    const user = userEvent.setup();
    page.refuse(`/environments/${s.envs.staging}/variables`);
    await user.type(nameBox(), "NEW_KEY");
    await user.type(valueBox(), `${SECRET}{Enter}`);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/^dev was created; staging was not: /);
    expect(alert.textContent).toContain("busy");
    expect(alert.textContent).not.toContain(SECRET);
    await waitFor(() => expect(keysOf(table)).toContain("NEW_KEY"));
    // what was typed stays for the retry, which is only about staging
    expect(nameBox().value).toBe("NEW_KEY");
    page.refuse(undefined);
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(nameBox().value).toBe(""));
    expect(page.creates).toHaveLength(3);
    expect(page.creates.filter((p) => p.includes(`/environments/${s.envs.dev}/`))).toHaveLength(1);
    expect(await s.audit("variable.create")).toHaveLength(5);
  });

  test("a name that is not a name, or a missing value, makes nothing", async () => {
    const s = await withKeys();
    const page = watched(s.cookie);
    mount(page.client);
    await matrix();
    const user = userEvent.setup();
    await user.type(nameBox(), "1bad");
    await user.type(valueBox(), "x{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/^A name starts with a letter/);
    // a good name with no value moves to the value and makes nothing
    await user.clear(nameBox());
    await user.clear(valueBox());
    await user.type(nameBox(), "GOOD{Enter}");
    expect(page.creates).toEqual([]);
    expect(document.activeElement).toBe(valueBox());
  });

  test("a reporter is refused at the first environment: nothing is made and the page says so", async () => {
    const s = await scene({ reporter: true });
    await s.put.project("REGION", "eu");
    const page = watched(s.cookie);
    mount(page.client);
    await matrix();
    const user = userEvent.setup();
    await user.type(nameBox(), "NEW_KEY");
    await user.type(valueBox(), `${SECRET}{Enter}`);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toMatch(/was created/);
    expect(alert.textContent).not.toContain(SECRET);
    expect(page.creates).toHaveLength(1);
    expect(await s.audit("variable.create")).toHaveLength(1);
  });
});
