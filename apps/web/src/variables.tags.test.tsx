import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import {
  addNew,
  must,
  openSecrets,
  ref,
  SECRET,
  scene as sceneOn,
  showSecrets,
} from "./variables.fixture";

// VWS-14: tags in the Secrets view: chips on the row, a Tag filter, search by tag, the details, and
// the two forms that set them.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

/** Variables with tags, made through the API: the project's own, and one environment's. */
async function tagged() {
  const s = await sceneOn(backend);
  const at = (
    key: string,
    tags: string[],
    over: { kind?: "plain" | "secret"; value?: string } = {},
  ) => s.scope.variables.post({ key, kind: "plain", value: "v", ...over, tags }).then(must);
  const api = await at("API_KEY", ["billing", "backend"], { kind: "secret", value: SECRET });
  await at("REGION", ["eu"], { value: "eu-west" });
  await at("PLAIN_ONE", []);
  return { ...s, api, at };
}

const chipsOf = (table: HTMLElement, key: string) =>
  Array.from(
    within(table).getByText(key, { selector: "code" }).closest("th")?.querySelectorAll(".tag") ??
      [],
  ).map((c) => c.textContent);
const keysOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole("rowheader")
    .map((h) => h.querySelector("code")?.textContent);
const tagSelect = () => screen.getByLabelText("Tag") as HTMLSelectElement;
/** The Tag select is in the Filter popover: open it (once) before reaching for it. */
const openFilter = async () => {
  const button = screen.getByRole("button", { name: /^Filter/ });
  if (button.getAttribute("aria-expanded") !== "true") await userEvent.setup().click(button);
};
const optionsOf = (select: HTMLSelectElement) => Array.from(select.options).map((o) => o.text);

describe("chips and the Tag filter", () => {
  test("a row shows its tags next to its name, sorted, and a row with none shows none", async () => {
    const s = await tagged();
    mount(s.client);
    const table = await openSecrets();
    expect(chipsOf(table, "API_KEY")).toEqual(["backend", "billing"]);
    expect(chipsOf(table, "REGION")).toEqual(["eu"]);
    expect(chipsOf(table, "PLAIN_ONE")).toEqual([]);
    // the secret's tags are not its value
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("the Tag select lists every tag of the environment once, and narrows the table to one", async () => {
    const s = await tagged();
    await s.at("EU_TOO", ["eu", "backend"]);
    await s.at("ZZ_LAST", ["alpha"]);
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await openFilter();
    expect(optionsOf(tagSelect())).toEqual(["All tags", "alpha", "backend", "billing", "eu"]);
    await user.selectOptions(tagSelect(), "eu");
    expect(keysOf(table)).toEqual(["EU_TOO", "REGION"]);
    await user.selectOptions(tagSelect(), "billing");
    expect(keysOf(table)).toEqual(["API_KEY"]);
    await user.selectOptions(tagSelect(), "All tags");
    expect(keysOf(table)).toEqual(["API_KEY", "EU_TOO", "PLAIN_ONE", "REGION", "ZZ_LAST"]);
  });

  test("a key that does not resolve is not shown under a tag, and is again under All tags", async () => {
    const s = await tagged();
    await s.at("BROKEN", [], { value: ref("NOWHERE") });
    mount(s.client);
    const table = await openSecrets();
    expect(keysOf(table)).toContain("BROKEN");
    const user = userEvent.setup();
    await openFilter();
    await user.selectOptions(tagSelect(), "eu");
    expect(keysOf(table)).toEqual(["REGION"]);
    await user.selectOptions(tagSelect(), "All tags");
    expect(keysOf(table)).toContain("BROKEN");
  });

  test("the Filter button holds the Tag select, counts the tag chosen, and Esc closes it with the filter kept", async () => {
    const s = await tagged();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Filter" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("Tag")).toBeNull();
    await user.click(button);
    await user.selectOptions(tagSelect(), "eu");
    expect(keysOf(table)).toEqual(["REGION"]);
    expect(screen.getByRole("button", { name: "Filter 1" })).toBe(button);
    await user.keyboard("{Escape}");
    expect(screen.queryByLabelText("Tag")).toBeNull();
    expect(document.activeElement).toBe(button);
    // the narrowed table and the count stay, and opening it again shows the tag still chosen
    expect(keysOf(table)).toEqual(["REGION"]);
    await user.click(button);
    expect(tagSelect().value).toBe("eu");
    await user.selectOptions(tagSelect(), "All tags");
    expect(screen.getByRole("button", { name: "Filter" })).toBe(button);
  });

  test("there is no Tag select while no variable has a tag", async () => {
    const s = await sceneOn(backend);
    await s.put.project("PLAIN_ONE", "v");
    mount(s.client);
    await openSecrets();
    // nothing to filter by: no Filter button either, and so no Tag select
    expect(screen.queryByRole("button", { name: /^Filter/ })).toBeNull();
    expect(screen.queryByLabelText("Tag")).toBeNull();
  });

  test("another environment keeps a tag it also has, and falls back to All tags for one it does not", async () => {
    const s = await tagged();
    const envOf = (name: string) => s.scope.environments({ envId: s.envs[name] ?? "" });
    await envOf("dev").variables.post({
      key: "DEV_ONLY",
      kind: "plain",
      value: "d",
      tags: ["dev-only"],
    });
    await envOf("staging").variables.post({
      key: "STG_ONLY",
      kind: "plain",
      value: "s",
      tags: ["stg"],
    });
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await openFilter();
    // "eu" is on a project variable, so staging has it too
    await user.selectOptions(tagSelect(), "eu");
    await showSecrets("staging");
    const table = await screen.findByRole("table", { name: "Variables in staging" });
    // choosing an environment is a press outside the popover, which closes it
    await openFilter();
    expect(tagSelect().value).toBe("eu");
    expect(keysOf(table)).toEqual(["REGION"]);
    // "dev-only" is not in staging: the table is not left empty by a tag that is not offered
    await showSecrets("dev");
    const dev = await screen.findByRole("table", { name: "Variables in dev" });
    await openFilter();
    await user.selectOptions(tagSelect(), "dev-only");
    expect(keysOf(dev)).toEqual(["DEV_ONLY"]);
    await showSecrets("staging");
    const staging = await screen.findByRole("table", { name: "Variables in staging" });
    await openFilter();
    expect(tagSelect().value).toBe("");
    expect(optionsOf(tagSelect())).toEqual(["All tags", "backend", "billing", "eu", "stg"]);
    expect(keysOf(staging)).toEqual(["API_KEY", "PLAIN_ONE", "REGION", "STG_ONLY"]);
  });

  test("search finds a tag as it finds a name", async () => {
    const s = await tagged();
    mount(s.client);
    const table = await openSecrets();
    await userEvent.setup().type(screen.getByLabelText("Search variables"), "bill");
    expect(keysOf(table)).toEqual(["API_KEY"]);
  });
});

describe("a row's details", () => {
  test("show the tags, or say there are none", async () => {
    const s = await tagged();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "API_KEY" }));
    const region = await screen.findByRole("region", { name: "API_KEY" });
    const dt = await within(region).findByText("Tags");
    const chips = Array.from(dt.nextElementSibling?.querySelectorAll(".tag") ?? []).map(
      (c) => c.textContent,
    );
    expect(chips).toEqual(["backend", "billing"]);
    await user.click(within(table).getByRole("button", { name: "PLAIN_ONE" }));
    const plain = await screen.findByRole("region", { name: "PLAIN_ONE" });
    await within(plain).findByText("No tags");
  });

  test("Edit description and tags sets both with one Save, and the row and details change without a reload", async () => {
    const s = await tagged();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "API_KEY" }));
    const region = await screen.findByRole("region", { name: "API_KEY" });
    await within(region).findByText("Version");
    await user.click(
      within(region).getByRole("button", { name: "Edit description and tags of API_KEY in dev" }),
    );
    const form = screen.getByRole("form", { name: "Describe and tag API_KEY" });
    const tags = within(form).getByLabelText("Tags") as HTMLInputElement;
    expect(tags.value).toBe("backend, billing");
    await user.clear(tags);
    await user.type(tags, "EU, ops  billing,eu");
    await user.type(within(form).getByLabelText("What it is for"), "The partner API");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    // an unnamed query: a named one inside waitFor can stall in happy-dom
    await waitFor(() =>
      expect(screen.queryAllByRole("form").map((f) => f.getAttribute("aria-label"))).not.toContain(
        "Describe and tag API_KEY",
      ),
    );
    await waitFor(() => expect(chipsOf(table, "API_KEY")).toEqual(["billing", "eu", "ops"]));
    const open = await screen.findByRole("region", { name: "API_KEY" });
    await within(open).findByText("The partner API");
    // the filter follows: a tag that is no longer used is gone, a new one is there
    await openFilter();
    expect(optionsOf(tagSelect())).toEqual(["All tags", "billing", "eu", "ops"]);
    // one value version, still: tags and a description do not make one
    expect(within(open).getByText("Version").nextElementSibling?.textContent).toBe("1");
    const stored = must(await s.scope.variables({ varId: s.api.id }).get());
    expect([stored.tags, stored.description, stored.version]).toEqual([
      ["billing", "eu", "ops"],
      "The partner API",
      1,
    ]);
    expect((await s.audit("variable.update")).map((e) => e.metadata)).toEqual([
      expect.objectContaining({ key: "API_KEY", fields: ["description", "tags"] }),
    ]);
  });

  test("a tag the API refuses shows its message, and nothing changes", async () => {
    const s = await tagged();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "API_KEY" }));
    const region = await screen.findByRole("region", { name: "API_KEY" });
    await within(region).findByText("Version");
    await user.click(
      within(region).getByRole("button", { name: "Edit description and tags of API_KEY in dev" }),
    );
    const form = screen.getByRole("form", { name: "Describe and tag API_KEY" });
    const tags = within(form).getByLabelText("Tags");
    await user.clear(tags);
    await user.type(tags, "ok, not_ok");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toBe(
      "Tag “not_ok” may hold lower-case letters, digits and hyphens, up to 24 characters",
    );
    expect(screen.getByRole("form", { name: "Describe and tag API_KEY" })).toBeTruthy();
    expect(chipsOf(table, "API_KEY")).toEqual(["backend", "billing"]);
    expect(must(await s.scope.variables({ varId: s.api.id }).get()).tags).toEqual([
      "backend",
      "billing",
    ]);
  });
});

describe("Add a variable", () => {
  test("takes tags, and the new row shows them", async () => {
    const s = await tagged();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    const form = await screen.findByRole("form", { name: "Add a variable" });
    await user.type(within(form).getByLabelText("Name"), "NEW_KEY");
    await user.type(within(form).getByLabelText("Value"), "v1");
    await user.type(within(form).getByLabelText("Tags (optional)"), "Web, eu web");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(chipsOf(table, "NEW_KEY")).toEqual(["eu", "web"]));
    // it applies to the environment the list shows, as Add a variable offers first
    const made = must(
      await s.scope
        .environments({ envId: s.envs.dev ?? "" })
        .variables.get({ query: { limit: 100 } }),
    ).items.find((v) => v.key === "NEW_KEY");
    expect(made?.tags).toEqual(["eu", "web"]);
  });

  test("a tag that is not one, or a ninth, is refused by name and nothing is added", async () => {
    const s = await tagged();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    const form = await screen.findByRole("form", { name: "Add a variable" });
    await user.type(within(form).getByLabelText("Name"), "REFUSED");
    await user.type(within(form).getByLabelText("Value"), "v1");
    const tags = within(form).getByLabelText("Tags (optional)");
    await user.type(tags, "a b c d e f g h i");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    expect((await within(form).findByRole("alert")).textContent).toBe("At most 8 tags");
    await user.clear(tags);
    await user.type(tags, "ok, Bad_Tag");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await waitFor(() =>
      expect(within(form).getByRole("alert").textContent).toBe(
        "Tag “bad_tag” may hold lower-case letters, digits and hyphens, up to 24 characters",
      ),
    );
    expect(keysOf(table)).not.toContain("REFUSED");
    const stored = must(await s.scope.variables.get({ query: { limit: 100 } })).items;
    expect(stored.some((v) => v.key === "REFUSED")).toBe(false);
  });

  test("with no tags typed, none are sent", async () => {
    const s = await tagged();
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    const form = await screen.findByRole("form", { name: "Add a variable" });
    await user.type(within(form).getByLabelText("Name"), "BARE_KEY");
    await user.type(within(form).getByLabelText("Value"), "v1");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(keysOf(table)).toContain("BARE_KEY"));
    expect(chipsOf(table, "BARE_KEY")).toEqual([]);
  });
});
