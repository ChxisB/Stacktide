import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";
import {
  addNew,
  cellOf,
  openSecrets,
  SECRET,
  scene as sceneOn,
  showCompare,
} from "./variables.fixture";

// VUI-7: "Add a variable" is a drawer: it makes the variable in one or several environments, can make a value for
// you, and can stay open for the next one.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/variables";
});

/** A scene with one variable already in it: an empty environment shows no table to wait for. */
const scene = async (options?: { environments?: string[] }) => {
  const s = await sceneOn(backend, options);
  await s.put.project("STARTER", "1");
  // how many variables the form has made: the one set up above is not its
  return { ...s, made: async () => (await s.audit("variable.create")).length - 1 };
};

/** A client that keeps every request (method, path, body), and can refuse a create in one environment. */
function watched(cookie: string) {
  const seen: { method: string; path: string; body: string }[] = [];
  let refuse: string | undefined;
  const client = clientVia(backend.api, cookie, async (request, send) => {
    seen.push({
      method: request.method,
      path: pathOf(request),
      body: request.method === "POST" ? await request.clone().text() : "",
    });
    if (refuse && request.method === "POST" && pathOf(request).includes(refuse)) {
      return down("the environment is busy");
    }
    return send();
  });
  return {
    client,
    seen,
    creates: () => seen.filter((r) => r.method === "POST" && /\/variables$/.test(r.path)),
    /** From now on a create whose path holds `part` is answered with a failure. */
    refuse: (part: string | undefined) => {
      refuse = part;
    },
  };
}

const openAdd = async () => {
  const user = userEvent.setup();
  await addNew(user, "Add a variable");
  const drawer = await screen.findByRole("dialog", { name: "New variable" });
  return { user, drawer, form: within(drawer).getByRole("form", { name: "Add a variable" }) };
};
const nameBox = (form: HTMLElement) => within(form).getByLabelText("Name") as HTMLInputElement;
const valueBox = (form: HTMLElement) => within(form).getByLabelText("Value") as HTMLInputElement;
const closed = () => screen.queryByRole("dialog") === null;

describe("the form is in a drawer", () => {
  test("Add a variable opens it from the list, with the open environment chosen; Cancel closes it", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    const { user, form } = await openAdd();
    expect((within(form).getByLabelText("Applies to") as HTMLSelectElement).value).toBe(
      s.envs.dev as string,
    );
    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(closed()).toBe(true));
    // nothing is beside the list any more
    expect(screen.queryByRole("form", { name: "Add a variable" })).toBeNull();
  });

  test("it opens from the matrix too, and Set there fills in the name and the environment", async () => {
    const s = await scene();
    await s.put.env("dev", "REGION", "eu");
    mount(s.client);
    await showCompare();
    const user = userEvent.setup();
    await addNew(user, "Add a variable");
    await screen.findByRole("dialog", { name: "New variable" });
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(closed()).toBe(true));

    await user.click(
      within(cellOf("REGION", "staging")).getByRole("button", { name: "Set REGION in staging" }),
    );
    const form = within(await screen.findByRole("dialog", { name: "New variable" })).getByRole(
      "form",
      { name: "Add a variable" },
    );
    expect(nameBox(form).value).toBe("REGION");
    expect((within(form).getByLabelText("Applies to") as HTMLSelectElement).value).toBe(
      s.envs.staging as string,
    );
  });

  test("Import variables opens its form in a drawer as well", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    await addNew(userEvent.setup(), "Import variables");
    const drawer = await screen.findByRole("dialog", { name: "Import" });
    expect(within(drawer).getByRole("form", { name: "Import variables" })).toBeTruthy();
  });

  test("Kind and Tags wait under Advanced options, closed; a secret is the kind until it is changed", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    const { form } = await openAdd();
    const advanced = within(form).getByText("Advanced options").closest("details");
    expect(advanced?.open).toBe(false);
    expect(advanced?.contains(within(form).getByLabelText("Kind"))).toBe(true);
    expect(advanced?.contains(within(form).getByLabelText("Tags (optional)"))).toBe(true);
    expect((within(form).getByLabelText("Kind") as HTMLSelectElement).value).toBe("secret");
    // what is for the person every time stays outside it
    for (const label of ["Name", "Value", "Applies to", "What it is for (optional)"])
      expect(advanced?.contains(within(form).getByLabelText(label))).toBe(false);
  });
});

describe("creating in several environments", () => {
  test("one environment makes one variable, in that environment, and the drawer closes on it", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const { user, form } = await openAdd();
    await user.type(nameBox(form), "API_URL");
    await user.type(valueBox(form), SECRET);
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await screen.findByRole("rowheader", { name: /API_URL/ });
    await waitFor(() => expect(closed()).toBe(true));
    expect(page.creates().map((r) => r.path)).toEqual([
      expect.stringMatching(new RegExp(`/environments/${s.envs.dev}/variables$`)),
    ]);
    expect(JSON.parse(page.creates()[0]?.body ?? "{}")).toEqual({
      key: "API_URL",
      kind: "secret",
      value: SECRET,
    });
    expect(await s.made()).toBe(1);
  });

  test("ticking another environment makes the variable in both: one create each", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const { user, form } = await openAdd();
    // dev is the one being made in, so it is not offered again
    expect(within(form).queryByRole("checkbox", { name: "dev" })).toBeNull();
    await user.type(nameBox(form), "API_URL");
    await user.type(valueBox(form), SECRET);
    await user.click(within(form).getByRole("checkbox", { name: "staging" }));
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(closed()).toBe(true));
    const paths = page.creates().map((r) => r.path);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toContain(`/environments/${s.envs.dev}/`);
    expect(paths[1]).toContain(`/environments/${s.envs.staging}/`);
    expect(await s.made()).toBe(2);
  });

  test("the ticks are only for a variable that is for an environment", async () => {
    const s = await scene();
    mount(s.client);
    await openSecrets();
    const { user, form } = await openAdd();
    expect(within(form).getByRole("group", { name: "Also create in" })).toBeTruthy();
    await user.selectOptions(
      within(form).getByLabelText("Applies to"),
      "Every environment of this project",
    );
    expect(within(form).queryByRole("group", { name: "Also create in" })).toBeNull();
  });

  test("a project with one environment has no ticks to offer", async () => {
    const s = await scene({ environments: ["dev"] });
    mount(s.client);
    await openSecrets();
    const { form } = await openAdd();
    expect(within(form).queryByRole("group", { name: "Also create in" })).toBeNull();
  });

  test("one made and one refused says which, keeps the one made, and a retry makes only the other", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const { user, form } = await openAdd();
    await user.type(nameBox(form), "API_URL");
    await user.type(valueBox(form), SECRET);
    await user.click(within(form).getByRole("checkbox", { name: "staging" }));
    page.refuse(`/environments/${s.envs.staging}/variables`);
    await user.click(within(form).getByRole("button", { name: "Add variable" }));

    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toMatch(/^dev was created; staging was not: /);
    expect(alert.textContent).toContain("busy");
    expect(alert.textContent).not.toContain(SECRET);
    // dev has it, in the list behind the drawer and in the audit trail
    await screen.findByRole("rowheader", { name: /API_URL/ });
    expect(await s.made()).toBe(1);
    // the form stays, with the value for the retry, and is now only about staging
    expect(valueBox(form).value).toBe(SECRET);
    expect((within(form).getByLabelText("Applies to") as HTMLSelectElement).value).toBe(
      s.envs.staging as string,
    );
    // dev is offered like any other environment, but it is not ticked: the retry makes only staging
    expect((within(form).getByRole("checkbox", { name: "dev" }) as HTMLInputElement).checked).toBe(
      false,
    );

    page.refuse(undefined);
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(closed()).toBe(true));
    const paths = page.creates().map((r) => r.path);
    // dev, staging (refused), staging again: dev is not made twice
    expect(paths).toHaveLength(3);
    expect(paths.filter((p) => p.includes(`/environments/${s.envs.dev}/`))).toHaveLength(1);
    expect(await s.made()).toBe(2);
  });

  test("nothing made and one refused shows the route's own words and keeps the form as it was", async () => {
    const s = await scene();
    await s.put.env("dev", "API_URL", "taken");
    mount(s.client);
    await openSecrets();
    const { user, form } = await openAdd();
    await user.type(nameBox(form), "API_URL");
    await user.type(valueBox(form), SECRET);
    await user.click(within(form).getByRole("checkbox", { name: "staging" }));
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toMatch(/already/i);
    // dev was first and refused: nothing was made, so there is no "was created" to say
    expect(alert.textContent).not.toMatch(/was created/);
    expect(within(form).getByRole("checkbox", { name: "staging" })).toHaveProperty("checked", true);
    expect(await s.made()).toBe(1);
  });
});

describe("Generate", () => {
  test("it fills a 32-character value, a different one each time, masked, and the value is in no request but the create", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const { user, form } = await openAdd();
    const generate = within(form).getByRole("button", { name: "Generate" });
    await user.click(generate);
    const first = valueBox(form).value;
    expect(first).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // a secret is typed masked, and a generated one is no different
    expect(valueBox(form).type).toBe("password");
    await user.click(generate);
    const second = valueBox(form).value;
    expect(second).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second).not.toBe(first);

    await user.type(nameBox(form), "SIGNING_KEY");
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await waitFor(() => expect(closed()).toBe(true));
    const creates = page.creates();
    expect(creates).toHaveLength(1);
    expect(JSON.parse(creates[0]?.body ?? "{}").value).toBe(second);
    // no other request, and no address, carries either value
    for (const r of page.seen.filter((x) => !creates.includes(x))) {
      expect(r.body.includes(first) || r.body.includes(second)).toBe(false);
      expect(r.path.includes(first) || r.path.includes(second)).toBe(false);
    }
    // and it is not on the page in the clear
    expect(document.body.textContent).not.toContain(second);
  });
});

describe("Add more", () => {
  test("it keeps the drawer open for the next one, with the name and value cleared and the name focused", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const { user, form } = await openAdd();
    await user.click(within(form).getByRole("checkbox", { name: "Add more" }));
    await user.type(nameBox(form), "ONE");
    await user.type(valueBox(form), SECRET);
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await screen.findByRole("rowheader", { name: /ONE/ });
    expect(screen.queryByRole("dialog", { name: "New variable" }) === null).toBe(false);
    expect(nameBox(form).value).toBe("");
    expect(valueBox(form).value).toBe("");
    expect(document.activeElement).toBe(nameBox(form));
    // the choice and the environment stay for the next
    expect(within(form).getByRole("checkbox", { name: "Add more" })).toHaveProperty(
      "checked",
      true,
    );
    expect((within(form).getByLabelText("Applies to") as HTMLSelectElement).value).toBe(
      s.envs.dev as string,
    );

    await user.type(nameBox(form), "TWO");
    await user.type(valueBox(form), SECRET);
    await user.click(within(form).getByRole("checkbox", { name: "Add more" }));
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    await screen.findByRole("rowheader", { name: /TWO/ });
    await waitFor(() => expect(closed()).toBe(true));
    expect(page.creates()).toHaveLength(2);
  });
});

describe("a name that is not one", () => {
  test("blocks Create: nothing is sent", async () => {
    const s = await scene();
    const page = watched(s.cookie);
    mount(page.client);
    await openSecrets();
    const { user, form } = await openAdd();
    await user.type(nameBox(form), "1BAD NAME");
    await user.type(valueBox(form), SECRET);
    await user.click(within(form).getByRole("button", { name: "Add variable" }));
    expect(page.creates()).toHaveLength(0);
    expect(screen.queryByRole("dialog", { name: "New variable" }) === null).toBe(false);
  });
});
