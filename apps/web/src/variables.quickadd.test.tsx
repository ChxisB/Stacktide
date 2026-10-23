import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, mount, pathOf, startBackend } from "./testing";
import {
  openSecrets,
  rowOf,
  SECRET,
  scene as sceneOn,
  showCompare,
  showSecrets,
} from "./variables.fixture";

// VUI-5: a row at the foot of the list that makes a secret in the open environment from a name and a value.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

const scene = (options?: { reporter?: boolean }) => sceneOn(backend, options);

/** A client that notes the path of every request, and can hold the create until it is let go. */
function watched(cookie: string) {
  const paths: string[] = [];
  let gate: Promise<void> | undefined;
  let open: (() => void) | undefined;
  const client = clientVia(backend.api, cookie, async (request, send) => {
    paths.push(`${request.method} ${pathOf(request)}`);
    if (gate && request.method === "POST") await gate;
    return send();
  });
  return {
    client,
    creates: () => paths.filter((p) => /^POST .*\/variables$/.test(p)),
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => open?.(),
  };
}

const nameBox = () => screen.getByLabelText("Add a variable name") as HTMLInputElement;
const valueBox = () => screen.getByLabelText("Add a variable value") as HTMLInputElement;
const quick = () => screen.getByRole("form", { name: "Quick add" });
/** The page, in its first environment, loaded, whether or not the environment has variables to list. */
const ready = () => screen.findByRole("form", { name: "Quick add" });
const nothingOf = (value: string) => expect(document.body.textContent).not.toContain(value);

describe("making a variable from the row", () => {
  test("it is the last thing in the card, below the list and its count, and its fields are masked and named", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const table = await openSecrets();
    expect(nameBox().placeholder).toBe("Add a variable name");
    expect(valueBox().type).toBe("password");
    expect(valueBox().autocomplete).toBe("off");
    // after the table, and not inside it: the list's rows and their count are what they were
    expect(table.contains(quick())).toBe(false);
    expect(table.compareDocumentPosition(quick()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  for (const field of ["name", "value"] as const) {
    test(`Enter in the ${field} makes a secret in the open environment, the list shows it, and the row clears`, async () => {
      const s = await scene();
      await s.put.env("dev", "COLOR", "blue");
      const page = watched(s.cookie);
      mount(page.client);
      await openSecrets("dev");
      const user = userEvent.setup();
      // the last field typed in is the one that has the focus when Enter is pressed
      if (field === "value") {
        await user.type(nameBox(), "DB_PASS");
        await user.type(valueBox(), `${SECRET}{Enter}`);
      } else {
        await user.type(valueBox(), SECRET);
        await user.type(nameBox(), "DB_PASS{Enter}");
      }
      const table = await screen.findByRole("table", { name: "Variables in dev" });
      await within(table).findByRole("rowheader", { name: /DB_PASS/ });
      const [value, source] = rowOf(table, "DB_PASS");
      // a secret, set for this environment, and not shown
      expect(value?.textContent).not.toContain(SECRET);
      expect(source?.textContent).toBe("Environment");
      expect(
        within(table)
          .getByRole("rowheader", { name: /DB_PASS/ })
          .querySelector(".key-mark .ico"),
      ).toBeTruthy();
      expect(page.creates()).toHaveLength(1);
      expect(await s.audit("variable.create")).toHaveLength(2); // COLOR, set up through the API, and DB_PASS
      // the row is ready for the next one, with nothing of the last in it
      expect(nameBox().value).toBe("");
      expect(valueBox().value).toBe("");
      expect(document.activeElement).toBe(nameBox());
      nothingOf(SECRET);
    });
  }

  test("an environment with no variables has the row, and it makes the first", async () => {
    const s = await scene();
    mount(s.client);
    await ready();
    expect(screen.getByText("No variables in dev yet.")).toBeTruthy();
    const user = userEvent.setup();
    await user.type(nameBox(), "FIRST");
    await user.type(valueBox(), "one{Enter}");
    await screen.findByRole("rowheader", { name: /FIRST/ });
    expect(screen.queryByText("No variables in dev yet.")).toBeNull();
  });

  test("the row is there when a search finds nothing, and is not part of what the search looks at", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: "Search variables" }), "zzz");
    expect(screen.getByText("No variables match “zzz”.")).toBeTruthy();
    expect(quick()).toBeTruthy();
  });

  test("a name alone moves on to the value and asks for nothing: no request, no message", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await ready();
    await userEvent.setup().type(nameBox(), "HALF{Enter}");
    expect(document.activeElement).toBe(valueBox());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(page.creates()).toHaveLength(0);
  });

  test("a bad name says what a name is and makes no request; what was typed stays", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await ready();
    const user = userEvent.setup();
    for (const bad of ["1ST", "has space", "dash-ed"]) {
      await user.clear(nameBox());
      await user.clear(valueBox());
      await user.type(nameBox(), bad);
      await user.type(valueBox(), `${SECRET}{Enter}`);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toMatch(/letter or an underscore/i);
      // the message is not the value, and is under the row
      expect(alert.textContent).not.toContain(SECRET);
      expect(
        quick().compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(nameBox().value).toBe(bad);
      expect(valueBox().value).toBe(SECRET);
    }
    expect(page.creates()).toHaveLength(0);
  });

  test("an empty name with a value says a name is needed, and makes no request", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await ready();
    await userEvent.setup().type(valueBox(), "v{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/letter or an underscore/i);
    expect(document.activeElement).toBe(nameBox());
    expect(page.creates()).toHaveLength(0);
  });

  test("a name already used in the environment shows the route's own words, keeps what was typed and makes nothing", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    mount(s.client);
    await openSecrets();
    const user = userEvent.setup();
    await user.type(nameBox(), "COLOR");
    await user.type(valueBox(), `${SECRET}{Enter}`);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already/i);
    expect(alert.textContent).not.toContain(SECRET);
    expect(nameBox().value).toBe("COLOR");
    expect(valueBox().value).toBe(SECRET);
    expect(await s.audit("variable.create")).toHaveLength(1);
    // the message goes with the next try
    await user.clear(nameBox());
    await user.type(nameBox(), "COLOR_2{Enter}");
    await screen.findByRole("rowheader", { name: /COLOR_2/ });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a second Enter while the first is on its way makes nothing more", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await ready();
    const user = userEvent.setup();
    await user.type(nameBox(), "ONCE");
    await user.type(valueBox(), "v");
    page.hold();
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(page.creates()).toHaveLength(1));
    page.release();
    await screen.findByRole("rowheader", { name: /ONCE/ });
    expect(page.creates()).toHaveLength(1);
    expect(await s.audit("variable.create")).toHaveLength(1);
  });

  test("a reporter, who may not write, sees the API's refusal under the row and nothing is made", async () => {
    const s = await scene({ reporter: true });
    mount(s.client);
    await ready();
    const user = userEvent.setup();
    await user.type(nameBox(), "NOPE");
    await user.type(valueBox(), `${SECRET}{Enter}`);
    expect((await screen.findByRole("alert")).textContent).toMatch(/permission|allowed|forbidden/i);
    expect(await s.audit("variable.create")).toHaveLength(0);
    expect(screen.queryByRole("rowheader", { name: /NOPE/ })).toBeNull();
  });

  test("the value is in no text, attribute or title of the page after it was made", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await ready();
    const user = userEvent.setup();
    await user.type(nameBox(), "HIDDEN");
    await user.type(valueBox(), `${SECRET}{Enter}`);
    await screen.findByRole("rowheader", { name: /HIDDEN/ });
    nothingOf(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const input of document.querySelectorAll("input, textarea"))
      expect((input as HTMLInputElement).value).not.toBe(SECRET);
  });

  test("details that are open in the drawer stay open, and what was revealed is hidden again", async () => {
    const s = await scene();
    await s.put.env("dev", "COLOR", "blue");
    await s.put.env("dev", "TOKEN", SECRET, true);
    mount(s.client);
    const table = await openSecrets();
    const user = userEvent.setup();
    await user.click(within(table).getByRole("button", { name: "COLOR" }));
    await user.click(screen.getByRole("button", { name: "Reveal all" }));
    await screen.findByText(SECRET);
    await user.type(nameBox(), "NEXT");
    await user.type(valueBox(), "v{Enter}");
    await screen.findByRole("rowheader", { name: /NEXT/ });
    expect(screen.getByRole("region", { name: "COLOR" })).toBeTruthy();
    nothingOf(SECRET);
  });

  test("another environment gets the variable when it is the open one", async () => {
    const s = await scene();
    mount(s.client);
    await showSecrets("staging");
    await ready();
    const user = userEvent.setup();
    await user.type(nameBox(), "ONLY_STAGING");
    await user.type(valueBox(), "v{Enter}");
    const table = await screen.findByRole("table", { name: "Variables in staging" });
    expect(rowOf(table, "ONLY_STAGING")[1]?.textContent).toBe("Environment");
    await showSecrets("dev");
    expect(screen.queryByRole("rowheader", { name: /ONLY_STAGING/ })).toBeNull();
  });

  test("the matrix has the row too (VUI-17), and its value says it applies to every environment shown; the list's does not", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await showCompare();
    await screen.findByRole("table", { name: "Variables by environment" });
    expect(screen.getByRole("form", { name: "Quick add" })).toBeTruthy();
    expect(screen.getByLabelText("Add a variable name")).toBeTruthy();
    expect(screen.getByLabelText("Add a variable value (applies to all)")).toBeTruthy();
    expect(screen.queryByLabelText("Add a variable value")).toBeNull();
  });
});
