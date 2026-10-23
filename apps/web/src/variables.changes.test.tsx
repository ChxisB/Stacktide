import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";
import { must, openSecrets, ref, SECRET, scene as sceneOn, showSecrets } from "./variables.fixture";

// VWS-10 and VUI-14: a **Changes** button in the strip opens a drawer that says who changed which variable of the
// chosen environment and when, newest first, from the project's changes feed. It holds no value, and nothing is read
// until it is opened.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);
const SECOND = "an0ther-s3cr3t-4d7e";

/** Opens the drawer with the button in the strip (once the Secrets list is up) and returns it. */
const card = async (env = "dev") => {
  await userEvent.setup().click(await screen.findByRole("button", { name: "Changes" }));
  return screen.findByRole("dialog", { name: `Changes in ${env}` });
};
/** The rows' text on one line each, the time as <when>. */
const texts = (region: HTMLElement) =>
  within(region)
    .getAllByRole("listitem")
    .map((li) =>
      (li.textContent ?? "")
        .replace(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/, "<when>")
        .replace(/\s+/g, " ")
        .trim(),
    );

/** Waits until a row says it: the key is a button or a code, so no one element holds the sentence. */
const sees = (region: HTMLElement, text: RegExp) =>
  waitFor(() =>
    expect(
      within(region)
        .queryAllByRole("listitem")
        .map((li) => li.textContent)
        .join("\n"),
    ).toMatch(text),
  );

/**
 * Seven versions in the order they were written: REGION 1, API_KEY 1 (dev), REGION 2 (with a reason),
 * STAGING_ONLY 1 (staging), ORG_LEVEL 1 (the organization's), API_KEY 2 (dev).
 */
async function withChanges() {
  const s = await scene();
  const region = await s.put.project("REGION", "eu");
  const apiKey = await s.put.env("dev", "API_KEY", SECRET, true);
  must(await s.scope.variables({ varId: region.id }).patch({ value: "us", reason: "moved to us" }));
  await s.put.env("staging", "STAGING_ONLY", "x");
  await s.put.org("ORG_LEVEL", "o");
  must(
    await s.scope
      .environments({ envId: s.envs.dev ?? "" })
      .variables({ varId: apiKey.id })
      .patch({ value: SECOND }),
  );
  return s;
}

describe("the Changes drawer", () => {
  test("a Changes button in the strip opens it, named for the environment, and no card is left on the page", async () => {
    const s = await withChanges();
    mount(s.client);
    const table = await openSecrets();
    const button = screen.getByRole("button", { name: "Changes" });
    expect(button.closest(".strip")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reveal all" }).closest(".strip")).toBe(
      button.closest(".strip"),
    );
    expect(screen.queryByRole("region", { name: /^Changes in/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    const drawer = await card();
    expect(
      within(drawer).getByText("Who changed which variable, and when. Values are not shown here."),
    ).toBeTruthy();
    // the page behind still ends at the table: nothing below it
    expect(screen.queryByRole("region", { name: /^Changes in/ })).toBeNull();
    expect(table.isConnected).toBe(true);
  });

  test("Esc closes it and the focus is back on the Changes button", async () => {
    const s = await withChanges();
    mount(s.client);
    await openSecrets();
    await within(await card()).findAllByRole("listitem");
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Changes" }));
  });

  test("a row for each change reaching the environment, newest first: who, which key, which version", async () => {
    const s = await withChanges();
    mount(s.client);
    await openSecrets();
    const who = `user ${s.admin.user.id.slice(0, 8)}`;
    const region = await card();
    await within(region).findAllByRole("listitem");
    expect(texts(region)).toEqual([
      `${who} changed API_KEY to version 2 <when> Environment`,
      `${who} changed REGION to version 2 <when> Project “moved to us”`,
      `${who} changed API_KEY to version 1 <when> Environment`,
      `${who} changed REGION to version 1 <when> Project`,
    ]);
  });

  test("each row has its time, as the history's rows do", async () => {
    const s = await withChanges();
    mount(s.client);
    await openSecrets();
    const region = await card();
    const times = await waitFor(() => {
      const found = Array.from(region.querySelectorAll("time"));
      expect(found).toHaveLength(4);
      return found;
    });
    for (const time of times) {
      expect(time.textContent).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
      expect(Number.isNaN(Date.parse(time.dateTime))).toBe(false);
    }
  });

  test("another environment shows its own changes and the project's", async () => {
    const s = await withChanges();
    mount(s.client);
    await openSecrets();
    await within(await card()).findAllByRole("listitem");
    await userEvent.setup().keyboard("{Escape}");
    await showSecrets("staging");
    const region = await card("staging");
    await waitFor(() => expect(texts(region).join("|")).toContain("STAGING_ONLY"));
    expect(texts(region).map((t) => t.replace(/^user \w{8} changed /, ""))).toEqual([
      "STAGING_ONLY to version 1 <when> Environment",
      "REGION to version 2 <when> Project “moved to us”",
      "REGION to version 1 <when> Project",
    ]);
    expect(region.textContent).not.toContain("API_KEY");
    expect(screen.queryByRole("dialog", { name: "Changes in dev" })).toBeNull();
  });

  test("it makes no request but the project's feed, for the environment chosen", async () => {
    const s = await withChanges();
    const asked: URL[] = [];
    const client = clientVia(backend.api, s.cookie, (request, send) => {
      if (pathOf(request).endsWith("/variable-changes")) asked.push(new URL(request.url));
      return send();
    });
    mount(client);
    await openSecrets();
    // nothing is read until the drawer is opened
    expect(asked).toEqual([]);
    await within(await card()).findAllByRole("listitem");
    expect(asked.map((u) => [u.pathname, Object.fromEntries(u.searchParams)])).toEqual([
      [
        `/organizations/${s.org.id}/projects/${s.project.id}/variable-changes`,
        { environmentId: s.envs.dev ?? "", limit: "20" },
      ],
    ]);
  });

  test("a project with none says so", async () => {
    const s = await scene();
    mount(s.client);
    // no variable, so no table to wait for
    await showSecrets();
    expect(await within(await card()).findByText("No changes yet.")).toBeTruthy();
  });

  test("Load more reads the next page once, and goes when there is no more", async () => {
    const s = await scene();
    const region = await s.put.project("REGION", "v1");
    for (let n = 2; n <= 25; n++) {
      must(await s.scope.variables({ varId: region.id }).patch({ value: `v${n}` }));
    }
    mount(s.client);
    await openSecrets();
    const changes = await card();
    await waitFor(() => expect(within(changes).getAllByRole("listitem")).toHaveLength(20));
    expect(texts(changes)[0]).toContain("REGION to version 25");
    expect(texts(changes)[19]).toContain("REGION to version 6");
    await userEvent.setup().click(within(changes).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(within(changes).getAllByRole("listitem")).toHaveLength(25));
    expect(texts(changes)[24]).toContain("REGION to version 1");
    expect(within(changes).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  test("a key opens that variable's details; a key that does not resolve has nothing to open", async () => {
    const s = await withChanges();
    await s.put.project("BROKEN", ref("NOWHERE"));
    mount(s.client);
    await openSecrets();
    const changes = await card();
    const user = userEvent.setup();
    // BROKEN is a change like another, but the list has no row for it to open
    await waitFor(() => expect(within(changes).getByText("BROKEN")).toBeTruthy());
    expect(within(changes).queryByRole("button", { name: "BROKEN" })).toBeNull();
    // API_KEY was changed twice: a button on each of its rows; it opens the details and the feed's drawer gives way
    await user.click(
      (await within(changes).findAllByRole("button", { name: "API_KEY" }))[0] as HTMLElement,
    );
    const details = await screen.findByRole("region", { name: "API_KEY" });
    await within(details).findByText("Version");
    expect(screen.queryByRole("dialog", { name: "Changes in dev" })).toBeNull();
  });

  test("an edit made on the page shows in the drawer the next time it is opened, without a reload", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const table = await openSecrets();
    await sees(await card(), /REGION to version 1/);
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    await user.click(within(table).getByRole("button", { name: "REGION" }));
    const details = await screen.findByRole("region", { name: "REGION" });
    await within(details).findByText("Version");
    await user.click(within(details).getByRole("button", { name: "Edit REGION in dev" }));
    const box = screen.getByLabelText("New value");
    await user.clear(box);
    await user.type(box, "us");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Edit REGION" }) === null).toBe(true),
    );
    await user.keyboard("{Escape}");
    await sees(await card(), /REGION to version 2/);
  });

  test("a reporter, who may read variables, sees it", async () => {
    const s = await scene({ reporter: true });
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    await sees(await card(), /REGION to version 1/);
  });

  test("when the feed cannot be read the drawer says so and can try again; the list is still there", async () => {
    const s = await withChanges();
    let broken = true;
    const client = clientVia(backend.api, s.cookie, (request, send) =>
      broken && pathOf(request).endsWith("/variable-changes")
        ? Promise.resolve(down("the feed is down"))
        : send(),
    );
    mount(client);
    const table = await openSecrets();
    const changes = await card();
    await within(changes).findByText("the feed is down");
    expect(within(table).getByRole("button", { name: "REGION" })).toBeTruthy();
    broken = false;
    await userEvent.setup().click(within(changes).getByRole("button", { name: "Try again" }));
    await sees(changes, /API_KEY to version 2/);
  });
});

describe("what the drawer does not hold", () => {
  test("no value, plain, secret or revealed, is in the drawer or in what the page cached for it", async () => {
    const s = await withChanges();
    const shown = mount(s.client);
    await openSecrets();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reveal all" }));
    await screen.findByText(SECOND);
    const changes = await card();
    await within(changes).findAllByRole("listitem");
    // the secrets are on screen now, in the list: not in the drawer
    for (const value of [SECRET, SECOND, "eu", "us"]) {
      expect(within(changes).queryByText(value)).toBeNull();
    }
    const held = JSON.stringify(
      shown.queries
        .getQueryCache()
        .getAll()
        .filter((q) => q.queryKey.includes("changes"))
        .map((q) => q.state.data),
    );
    expect(held).toContain("API_KEY");
    for (const value of [SECRET, SECOND, '"eu"', '"us"']) expect(held).not.toContain(value);
  });
});
