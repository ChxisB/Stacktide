import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseDotenv } from "@orch/core";
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
  showEnvs,
} from "./variables.fixture";

// FLD-13: a variable moves to another folder from its details (with a warning when readers would break), and Reveal all
// and Download .env act on the open folder.

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());

/** The browser's side of a download: the blobs made. */
const made: Blob[] = [];
const real = {
  create: URL.createObjectURL,
  revoke: URL.revokeObjectURL,
  click: HTMLAnchorElement.prototype.click,
};
beforeEach(() => {
  window.location.hash = "#/variables";
  made.length = 0;
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    made.push(blob as Blob);
    return `blob:test/${made.length}`;
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = () => {};
});
afterEach(() => {
  URL.createObjectURL = real.create;
  URL.revokeObjectURL = real.revoke;
  HTMLAnchorElement.prototype.click = real.click;
});

const scene = () => sceneOn(backend);
type Scene = Awaited<ReturnType<typeof scene>>;

async function folder(s: Scene, path: string) {
  const at = path.lastIndexOf("/");
  const parent = at === 0 ? "/" : path.slice(0, at);
  return must(await s.scope.folders.post({ parent, name: path.slice(at + 1) }));
}
/** A project variable in a folder. */
async function put(s: Scene, where: string, key: string, value: string, secret = false) {
  must(
    await s.scope.variables.post({
      key,
      kind: secret ? "secret" : "plain",
      value,
      folder: where,
    }),
  );
}
/** The keys the project holds in a folder, read from the API. */
const keysIn = async (s: Scene, where: string) =>
  must(await s.scope.variables.get({ query: { folder: where, limit: 100 } })).items.map(
    (v) => v.key,
  );

/** Opens a variable's details from the list. */
async function details(user: ReturnType<typeof userEvent.setup>, key: string) {
  const table = await openSecrets();
  await user.click(within(table).getByRole("button", { name: key }));
  const region = await screen.findByRole("region", { name: key });
  await within(region).findByText("Version");
  return region;
}
const moveForm = (key: string) => screen.findByRole("form", { name: `Move ${key}` });

describe("Move to folder", () => {
  test("the row leaves the list and is in the folder it was moved to, as the same variable", async () => {
    const s = await scene();
    const region0 = await s.put.project("REGION", "eu");
    await s.put.project("KEEP", "k");
    await folder(s, "/payments");
    mount(s.client);
    const user = userEvent.setup();
    const region = await details(user, "REGION");
    await user.click(within(region).getByRole("button", { name: "Move REGION in dev" }));
    const form = await moveForm("REGION");
    const to = within(form).getByRole("combobox", { name: "Move to folder" });
    // every folder of the project, and the root; the folder it is in is not offered
    expect(
      within(to)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["/payments"]);
    await user.selectOptions(to, "/payments");
    await user.click(within(form).getByRole("button", { name: "Move" }));
    await waitFor(() =>
      expect(screen.queryByRole("form", { name: "Move REGION" }) === null).toBe(true),
    );
    const list = await screen.findByRole("table", { name: /^Variables in dev/ });
    await waitFor(() =>
      expect(within(list).queryByRole("button", { name: "REGION" }) === null).toBe(true),
    );
    expect(within(list).getByRole("button", { name: "KEEP" })).toBeTruthy();
    expect(await keysIn(s, "/")).toEqual(["KEEP"]);
    const moved = must(
      await s.scope.variables.get({ query: { folder: "/payments", limit: 100 } }),
    ).items;
    expect(moved.map((v) => [v.id, v.key, v.version])).toEqual([[region0.id, "REGION", 1]]);
  });

  test("from a folder, the root is offered, and the move goes there", async () => {
    const s = await scene();
    // the root holds one, or its list is not drawn
    await s.put.project("ROOT_KEEP", "r");
    await folder(s, "/payments");
    await put(s, "/payments", "PAY_URL", "https://pay.example");
    mount(s.client);
    const user = userEvent.setup();
    await openSecrets();
    await user.click(await screen.findByRole("button", { name: "Open payments" }));
    const table = await screen.findByRole("table", { name: /^Variables in dev/ });
    await user.click(within(table).getByRole("button", { name: "PAY_URL" }));
    const region = await screen.findByRole("region", { name: "PAY_URL" });
    await within(region).findByText("Version");
    await user.click(within(region).getByRole("button", { name: "Move PAY_URL in dev" }));
    const form = await moveForm("PAY_URL");
    const to = within(form).getByRole("combobox", { name: "Move to folder" });
    expect(
      within(to)
        .getAllByRole("option")
        .map((o) => (o as HTMLOptionElement).value),
    ).toEqual(["/"]);
    await user.click(within(form).getByRole("button", { name: "Move" }));
    await waitFor(async () =>
      expect((await keysIn(s, "/")).sort()).toEqual(["PAY_URL", "ROOT_KEEP"]),
    );
    expect(await keysIn(s, "/payments")).toEqual([]);
  });

  test("a move that would leave a reader unresolved names it and does nothing until Move anyway", async () => {
    const s = await scene();
    await s.put.project("BASE", "x");
    await s.put.project("URL", `${ref("BASE")}/p`);
    await folder(s, "/payments");
    mount(s.client);
    const user = userEvent.setup();
    const region = await details(user, "BASE");
    await user.click(within(region).getByRole("button", { name: "Move BASE in dev" }));
    const form = await moveForm("BASE");
    await user.selectOptions(
      within(form).getByRole("combobox", { name: "Move to folder" }),
      "/payments",
    );
    await user.click(within(form).getByRole("button", { name: "Move" }));
    // the address of what would break, in words and not as the API's own sentence
    const warning = await within(form).findByRole("alert");
    expect(warning.textContent).toContain("/URL");
    expect(warning.textContent).not.toContain("`force`");
    expect(await keysIn(s, "/")).toEqual(["BASE", "URL"]);
    await user.click(within(form).getByRole("button", { name: "Move anyway" }));
    await waitFor(async () => expect(await keysIn(s, "/payments")).toEqual(["BASE"]));
    expect(await keysIn(s, "/")).toEqual(["URL"]);
  });

  test("a failure of Move anyway is shown, beside the list of what would break", async () => {
    const s = await scene();
    await s.put.project("BASE", "x");
    await s.put.project("URL", `${ref("BASE")}/p`);
    const payments = await folder(s, "/payments");
    mount(s.client);
    const user = userEvent.setup();
    const region = await details(user, "BASE");
    await user.click(within(region).getByRole("button", { name: "Move BASE in dev" }));
    const form = await moveForm("BASE");
    await user.selectOptions(
      within(form).getByRole("combobox", { name: "Move to folder" }),
      "/payments",
    );
    await user.click(within(form).getByRole("button", { name: "Move" }));
    await within(form).findByRole("button", { name: "Move anyway" });
    // the folder goes while the warning is up: the next try is refused for another reason
    must(await s.scope.folders({ folderId: payments.id }).delete());
    await user.click(within(form).getByRole("button", { name: "Move anyway" }));
    await waitFor(() => expect(within(form).getAllByRole("alert")).toHaveLength(2));
    expect(form.textContent).toContain("/URL");
    expect(form.textContent).toMatch(/not found/i);
    expect(await keysIn(s, "/")).toEqual(["BASE", "URL"]);
  });

  test("another choice of folder drops the warning, and the button is Move again", async () => {
    const s = await scene();
    await s.put.project("BASE", "x");
    await s.put.project("URL", `${ref("BASE")}/p`);
    await folder(s, "/payments");
    await folder(s, "/search");
    mount(s.client);
    const user = userEvent.setup();
    const region = await details(user, "BASE");
    await user.click(within(region).getByRole("button", { name: "Move BASE in dev" }));
    const form = await moveForm("BASE");
    const to = within(form).getByRole("combobox", { name: "Move to folder" });
    await user.selectOptions(to, "/payments");
    await user.click(within(form).getByRole("button", { name: "Move" }));
    await within(form).findByRole("button", { name: "Move anyway" });
    await user.selectOptions(to, "/search");
    expect(within(form).queryByRole("alert")).toBeNull();
    expect(within(form).getByRole("button", { name: "Move" })).toBeTruthy();
    expect(within(form).queryByRole("button", { name: "Move anyway" })).toBeNull();
  });

  test("a protected environment says a move is not available, and offers none", async () => {
    const s = await scene();
    await s.put.env("dev", "DEV_ONLY", "1");
    await folder(s, "/payments");
    must(
      await s.scope.environments({ envId: s.envs.dev ?? "" }).protection.put({ protected: true }),
    );
    mount(s.client);
    const region = await details(userEvent.setup(), "DEV_ONLY");
    expect(region.textContent).toContain("A variable of a protected environment cannot be moved");
    expect(within(region).queryByRole("button", { name: /^Move / })).toBeNull();
  });

  test("a project's variable, shown in a protected environment, can still move: only the environment's own are held", async () => {
    const s = await scene();
    await s.put.project("SHARED", "1");
    await folder(s, "/payments");
    must(
      await s.scope.environments({ envId: s.envs.dev ?? "" }).protection.put({ protected: true }),
    );
    mount(s.client);
    const region = await details(userEvent.setup(), "SHARED");
    expect(region.textContent).not.toContain("cannot be moved");
    expect(within(region).getByRole("button", { name: "Move SHARED in dev" })).toBeTruthy();
  });

  test("with no other folder there is nothing to choose, and the move waits", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const user = userEvent.setup();
    const region = await details(user, "REGION");
    await user.click(within(region).getByRole("button", { name: "Move REGION in dev" }));
    const form = await moveForm("REGION");
    expect(form.textContent).toContain("There is no other folder");
    expect(within(form).queryByRole("combobox")).toBeNull();
    expect((within(form).getByRole("button", { name: "Move" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("an organization's variable sits at the root and has no move", async () => {
    const s = await scene();
    await s.put.org("ORG_WIDE", "o");
    await folder(s, "/payments");
    mount(s.client);
    const region = await details(userEvent.setup(), "ORG_WIDE");
    expect(within(region).queryByRole("button", { name: /^Move / })).toBeNull();
  });

  test("a refusal that is not about readers (the name is taken there) shows the API's words", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    await folder(s, "/payments");
    await put(s, "/payments", "REGION", "other");
    mount(s.client);
    const user = userEvent.setup();
    const region = await details(user, "REGION");
    await user.click(within(region).getByRole("button", { name: "Move REGION in dev" }));
    const form = await moveForm("REGION");
    await user.selectOptions(
      within(form).getByRole("combobox", { name: "Move to folder" }),
      "/payments",
    );
    await user.click(within(form).getByRole("button", { name: "Move" }));
    const alert = await within(form).findByRole("alert");
    expect(alert.textContent).toMatch(/already/i);
    expect(within(form).queryByRole("button", { name: "Move anyway" })).toBeNull();
    expect(await keysIn(s, "/")).toEqual(["REGION"]);
  });
});

describe("Reveal all and Download .env in a folder", () => {
  async function inPayments() {
    const s = await scene();
    await s.put.project("ROOT_KEY", "root-secret-1a2b", true);
    await folder(s, "/payments");
    await put(s, "/payments", "PAY_KEY", "pay-secret-7d1", true);
    await put(s, "/payments", "PAY_URL", "https://pay.example");
    mount(s.client);
    await openSecrets();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open payments" }));
    await screen.findByRole("button", { name: "PAY_URL" });
    return s;
  }

  test("the line says which folder, and the root's line is as it was", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    await folder(s, "/payments");
    await put(s, "/payments", "PAY_URL", "https://pay.example");
    mount(s.client);
    await openSecrets();
    expect(document.body.textContent).toContain(
      "Reveal all and Download .env show or write every value of dev, secrets included.",
    );
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open payments" }));
    await screen.findByRole("button", { name: "PAY_URL" });
    expect(document.body.textContent).toContain(
      "Reveal all and Download .env show or write every value of dev in /payments, secrets included.",
    );
  });

  test("Reveal all shows the open folder's secrets and not the root's", async () => {
    await inPayments();
    await userEvent.setup().click(screen.getByRole("button", { name: "Reveal all" }));
    await screen.findByText("pay-secret-7d1");
    expect(document.body.textContent).not.toContain("root-secret-1a2b");
  });

  test("Download .env holds that folder's lines only", async () => {
    await inPayments();
    await userEvent.setup().click(screen.getByRole("button", { name: "Download .env" }));
    await screen.findByText(/Downloaded acme-web-dev\.env: 2 variables/);
    const text = (await made[0]?.text()) ?? "";
    expect(parseDotenv(text).entries).toEqual([
      { key: "PAY_KEY", value: "pay-secret-7d1" },
      { key: "PAY_URL", value: "https://pay.example" },
    ]);
    expect(text).not.toContain("root-secret-1a2b");
    expect(document.body.textContent).not.toContain("pay-secret-7d1");
  });

  test("the root's download is the root's lines only, as before folders", async () => {
    const s = await scene();
    await s.put.project("ROOT_KEY", SECRET, true);
    await folder(s, "/payments");
    await put(s, "/payments", "PAY_URL", "https://pay.example");
    mount(s.client);
    await showEnvs("dev");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Download .env" }));
    await screen.findByText(/Downloaded acme-web-dev\.env: 1 variable,/);
    expect(parseDotenv((await made[0]?.text()) ?? "").entries).toEqual([
      { key: "ROOT_KEY", value: SECRET },
    ]);
  });
});

describe("what a reference may say", () => {
  test("the edit form says which reference reads this folder and which another", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    const user = userEvent.setup();
    const region = await details(user, "REGION");
    await user.click(within(region).getByRole("button", { name: "Edit REGION in dev" }));
    const edit = await screen.findByRole("form", { name: "Edit REGION" });
    expect(edit.textContent).toContain(`${ref("KEY")} reads a variable of this folder`);
    expect(edit.textContent).toContain(`${ref("/folder/KEY")} one of another folder`);
  });

  test("the add form says the same", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    mount(s.client);
    await openSecrets();
    await addNew(userEvent.setup(), "Add a variable");
    const add = await screen.findByRole("form", { name: "Add a variable" });
    expect(add.textContent).toContain(`${ref("KEY")} reads a variable of this folder`);
    expect(add.textContent).toContain(`${ref("/folder/KEY")} one of another folder`);
  });

  test("the details mark an absolute reference as they mark a relative one", async () => {
    const s = await scene();
    await folder(s, "/payments");
    await put(s, "/payments", "PAY_URL", "https://pay.example");
    await s.put.project("LOCAL", "here");
    await s.put.project("CALL", `${ref("/payments/PAY_URL")}/v1 ${ref("LOCAL")} $\${NOT}`);
    mount(s.client);
    const user = userEvent.setup();
    const table = await openSecrets();
    await user.click(within(table).getByRole("button", { name: "CALL" }));
    const region = await screen.findByRole("region", { name: "CALL" });
    const written = await within(region).findByText(/\/v1/);
    expect(Array.from(written.querySelectorAll("mark")).map((m) => m.textContent)).toEqual([
      ref("/payments/PAY_URL"),
      ref("LOCAL"),
    ]);
  });
});
