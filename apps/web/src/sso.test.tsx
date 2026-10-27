import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createSsoProvider, getSsoProvider, openSsoSecret } from "@orch/db";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, mount, startBackend } from "./testing";

const ISSUER = "https://idp.example.com/realms/acme";
const SECRET = "idp-client-SECRET-CANARY-5521";
const NEW_SECRET = "idp-client-SECRET-CANARY-NEW-8830";

/** What the provider answers when the API asks it (the web test's API has no network of its own to a provider). */
const idp = { keys: [{ kty: "RSA", kid: "k1", n: "AQAB", e: "AQAB" }] as unknown[], down: false };
const answer = async (url: string) => {
  if (idp.down) return new Response("nope", { status: 500 });
  const path = new URL(url).pathname;
  if (path.endsWith("/.well-known/openid-configuration")) {
    return Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/certs`,
    });
  }
  return Response.json({ keys: idp.keys });
};

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend(undefined, {
    oidc: { check: async (raw) => new URL(raw), fetch: answer },
  });
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/settings";
  idp.down = false;
});
afterEach(cleanup);

async function world(over: { provider?: boolean; domains?: string[] } = {}) {
  const org = await backend.organization();
  const as = (role: "owner" | "admin" | "member" | "viewer") =>
    backend.signIn(`${role} of ${org.slug}`, { orgRoles: { [org.id]: role }, projectRoles: {} });
  const [owner, admin, member, viewer] = [
    await as("owner"),
    await as("admin"),
    await as("member"),
    await as("viewer"),
  ];
  if (over.provider) {
    await createSsoProvider(backend.t.db, backend.keys, {
      organizationId: org.id,
      issuer: ISSUER,
      clientId: "orch",
      clientSecret: SECRET,
      emailDomains: over.domains ?? ["acme.example"],
      roleMap: [{ claim: "groups", value: "platform", role: "admin" }],
    });
  }
  return { org, owner, admin, member, viewer };
}

const region = () => screen.findByRole("region", { name: "Single sign-on" }, { timeout: 5000 });
const press = async (name: string | RegExp) =>
  userEvent.setup().click(await screen.findByRole("button", { name }, { timeout: 5000 }));
const fill = async (label: string, text: string) =>
  userEvent.setup().type(await screen.findByLabelText(label), text);
const toasted = () => document.querySelector(".toast-text")?.textContent || undefined;
/** The delete question, an alert dialog found by its name. */
const asked = (name: string) => screen.findByRole("alertdialog", { name }, { timeout: 5000 });
const drawerOf = (name: string) => screen.findByRole("dialog", { name }, { timeout: 5000 });
/** The state word of the section, as its badge says it. */
const state = (section: HTMLElement) => section.querySelector(".st")?.textContent;

describe("the single sign-on section of the settings page", () => {
  test("an owner or an admin of an organization with none is told so; only an owner can set one up", async () => {
    const w = await world();
    mount(w.admin.client);
    let section = await region();
    await within(section).findByRole(
      "heading",
      { name: "No identity provider yet" },
      { timeout: 5000 },
    );
    expect(within(section).queryByRole("button", { name: /Set up/ })).toBeNull();
    expect(section.textContent).toContain("Only an owner can change it");
    expect(section.textContent).toContain("An owner can set one up.");
    cleanup();
    mount(w.owner.client);
    section = await region();
    await within(section).findByRole("button", { name: "Set up…" }, { timeout: 5000 });
    expect(section.textContent).toContain("Set one up so people can sign in");
  });

  test("a member or a viewer sees nothing of it", async () => {
    const w = await world({ provider: true });
    for (const who of [w.member, w.viewer]) {
      mount(who.client);
      await screen.findByRole("heading", { name: "Your access" }, { timeout: 5000 });
      expect(screen.queryByRole("region", { name: "Single sign-on" })).toBeNull();
      expect(document.body.textContent).not.toContain(ISSUER);
      cleanup();
    }
  });

  test("an admin reads the provider and its rules, with no control and no secret", async () => {
    const w = await world({ provider: true });
    mount(w.admin.client);
    const section = await region();
    await within(section).findByText(ISSUER, {}, { timeout: 5000 });
    // a facts list: each term has its answer
    const facts = [...section.querySelectorAll("dl dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(facts).toEqual([
      ["Issuer", ISSUER],
      ["Client ID", "orch"],
      ["Client secret", "Stored encrypted, never shown"],
      ["Email domains", "acme.example"],
      ["State", "Off"],
      ["Changed", expect.any(String)],
    ]);
    // a state is a glyph and a word
    expect(section.querySelector(".st-quiet svg")).not.toBeNull();
    expect(state(section)).toBe("Off");
    const rules = within(section).getByRole("table", { name: "Role rules" });
    expect(
      within(rules)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Claim", "Value", "Role"]);
    const rule = within(rules).getByRole("rowheader", { name: "groups" }).closest("tr");
    expect([...(rule?.querySelectorAll("td") ?? [])].map((c) => c.textContent)).toEqual([
      "platform",
      "admin",
    ]);
    expect(section.textContent).not.toContain(SECRET);
    expect(within(section).queryAllByRole("button")).toEqual([]);
  });

  test("an owner sets one up in a drawer: it starts off, and the secret typed is stored and shown nowhere", async () => {
    const w = await world();
    mount(w.owner.client);
    await press("Set up…");
    const drawer = await drawerOf("Set up an identity provider");
    await fill("Issuer", ISSUER);
    await fill("Client ID", "orch");
    await fill("Client secret", SECRET);
    await fill("Email domains", "ACME.example");
    await fill("Rule 1 value", "platform");
    await userEvent.setup().selectOptions(screen.getByLabelText("Rule 1 role"), "admin");
    await press("Set up");
    // not `expect(element).toBeNull()`: formatting a whole drawer for a failed try takes seconds
    await waitFor(() => expect(drawer.isConnected).toBe(false), { timeout: 5000 });
    expect(toasted()).toBe("Set up the identity provider.");
    const section = await region();
    await waitFor(() => expect(state(section)).toBe("Off"), { timeout: 5000 });
    expect(section.textContent).toContain(ISSUER);
    expect(section.textContent).toContain("acme.example");
    expect(document.body.textContent).not.toContain(SECRET);
    const made = await getSsoProvider(backend.t.db, w.org.id);
    expect(made).toMatchObject({
      issuer: ISSUER,
      clientId: "orch",
      enabled: false,
      emailDomains: ["acme.example"],
      roleMap: [{ claim: "groups", value: "platform", role: "admin" }],
    });
    expect(await openSsoSecret(backend.t.db, backend.keys, made?.id ?? "")).toBe(SECRET);
  });

  test("what the API refuses is said in the drawer, which stays with what was typed, and nothing is made", async () => {
    const w = await world();
    mount(w.owner.client);
    await press("Set up…");
    const drawer = await drawerOf("Set up an identity provider");
    await fill("Issuer", "https://idp.example.com/realms/acme?x=1");
    await fill("Client ID", "orch");
    await fill("Client secret", SECRET);
    await fill("Rule 1 value", "platform");
    await press("Set up");
    await waitFor(() => expect(within(drawer).queryByRole("alert")).not.toBeNull(), {
      timeout: 5000,
    });
    const refusal = within(drawer).getByRole("alert");
    expect(refusal.classList.contains("callout-bad")).toBe(true);
    expect(refusal.textContent).toBeTruthy();
    expect(drawer.isConnected).toBe(true);
    expect((within(drawer).getByLabelText("Client ID") as HTMLInputElement).value).toBe("orch");
    expect(await getSsoProvider(backend.t.db, w.org.id)).toBeUndefined();
    expect(toasted()).toBeUndefined();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("while it is being saved the drawer stays: Cancel is off and Esc does nothing, so a refusal is not lost", async () => {
    const w = await world();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mount(
      clientVia(backend.api, w.owner.cookie, async (request, send) => {
        if (request.method !== "GET") await held;
        return send();
      }),
    );
    await press("Set up…");
    const drawer = await drawerOf("Set up an identity provider");
    await fill("Issuer", ISSUER);
    await fill("Client ID", "orch");
    await fill("Client secret", SECRET);
    await fill("Rule 1 value", "platform");
    await press("Set up");
    await within(drawer).findByRole("button", { name: "Saving…" });
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await userEvent.setup().keyboard("{Escape}");
    expect(drawer.isConnected).toBe(true);
    release();
    await waitFor(() => expect(drawer.isConnected).toBe(false), { timeout: 5000 });
    expect(toasted()).toBe("Set up the identity provider.");
  });

  test("a rule is a card of its own, four at most, and removing one leaves focus on Add rule", async () => {
    const w = await world();
    mount(w.owner.client);
    await press("Set up…");
    const drawer = await drawerOf("Set up an identity provider");
    const user = userEvent.setup();
    const titles = () =>
      within(drawer)
        .getAllByText(/^Rule \d$/)
        .map((t) => t.textContent);
    const add = within(drawer).getByRole("button", { name: "Add rule" }) as HTMLButtonElement;
    expect(titles()).toEqual(["Rule 1"]);
    for (let i = 0; i < 3; i++) await user.click(add);
    expect(titles()).toEqual(["Rule 1", "Rule 2", "Rule 3", "Rule 4"]);
    expect(add.disabled).toBe(true);
    await user.type(within(drawer).getByLabelText("Rule 3 value"), "ops");
    await user.click(within(drawer).getByRole("button", { name: "Remove rule 2" }));
    expect(titles()).toEqual(["Rule 1", "Rule 2", "Rule 3"]);
    // the third is the second now
    expect((within(drawer).getByLabelText("Rule 2 value") as HTMLInputElement).value).toBe("ops");
    expect(add.disabled).toBe(false);
    expect(document.activeElement).toBe(add);
  });

  test("it is turned on and off by toast; one with no domain cannot be turned on, and the page says why", async () => {
    const w = await world({ provider: true, domains: [] });
    mount(w.owner.client);
    const section = await region();
    await within(section).findByText(ISSUER, {}, { timeout: 5000 });
    await press("Turn on");
    const refusal = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(refusal.textContent).toContain("at least one email domain");
    expect(refusal.classList.contains("callout-bad")).toBe(true);
    expect((await getSsoProvider(backend.t.db, w.org.id))?.enabled).toBe(false);
    expect(toasted()).toBeUndefined();
    cleanup();

    const ready = await world({ provider: true });
    mount(ready.owner.client);
    await press("Turn on");
    await screen.findByRole("button", { name: "Turn off" }, { timeout: 5000 });
    await waitFor(() => expect(toasted()).toBe("Turned on single sign-on."), { timeout: 5000 });
    expect(state(await region())).toBe("On");
    expect((await getSsoProvider(backend.t.db, ready.org.id))?.enabled).toBe(true);
    await press("Turn off");
    await screen.findByRole("button", { name: "Turn on" }, { timeout: 5000 });
    await waitFor(() => expect(toasted()).toBe("Turned off single sign-on."), { timeout: 5000 });
    expect(state(await region())).toBe("Off");
    expect((await getSsoProvider(backend.t.db, ready.org.id))?.enabled).toBe(false);
  });

  test("the test says what it found in a callout, or why it could not", async () => {
    const w = await world({ provider: true });
    mount(w.owner.client);
    await press("Test");
    const found = await screen.findByText(/1 signing key/, {}, { timeout: 5000 });
    expect(found.closest(".callout-ok")).not.toBeNull();
    expect(found.closest('[role="status"]')).not.toBeNull();
    idp.down = true;
    await press("Test");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("answered 500"), {
      timeout: 5000,
    });
    expect(screen.getByRole("alert").classList.contains("callout-bad")).toBe(true);
    // the news of the first try is gone
    expect(screen.queryByText(/1 signing key/)).toBeNull();
  });

  test("a change is made in a drawer: the secret is kept unless a new one is typed, and the issuer is not offered for change", async () => {
    const w = await world({ provider: true });
    mount(w.owner.client);
    await press("Edit…");
    const drawer = await drawerOf("Edit the identity provider");
    const form = within(drawer).getByRole("form", { name: "Identity provider" });
    expect(within(form).queryByLabelText("Issuer")).toBeNull();
    expect(form.textContent).toContain(ISSUER);
    const id = userEvent.setup();
    const clientId = within(form).getByLabelText("Client ID");
    await id.clear(clientId);
    await id.type(clientId, "orch-2");
    expect((within(form).getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
    await press("Save changes");
    await waitFor(() => expect(drawer.isConnected).toBe(false), { timeout: 5000 });
    expect(toasted()).toBe("Saved the identity provider.");
    // the drawer gives focus back to what opened it
    expect(document.activeElement === screen.getByRole("button", { name: "Edit…" })).toBe(true);
    await within(await region()).findByText("orch-2", {}, { timeout: 5000 });
    const before = await getSsoProvider(backend.t.db, w.org.id);
    expect(before?.clientId).toBe("orch-2");
    expect(await openSsoSecret(backend.t.db, backend.keys, before?.id ?? "")).toBe(SECRET);

    await press("Edit…");
    const again = await drawerOf("Edit the identity provider");
    await fill("Client secret", NEW_SECRET);
    await press("Save changes");
    await waitFor(() => expect(again.isConnected).toBe(false), { timeout: 5000 });
    await waitFor(async () =>
      expect(await openSsoSecret(backend.t.db, backend.keys, before?.id ?? "")).toBe(NEW_SECRET),
    );
    expect(document.body.textContent).not.toContain(NEW_SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("deleting asks first, in a dialog that says what follows, and keeping it changes nothing", async () => {
    const w = await world({ provider: true });
    mount(w.owner.client);
    await press("Delete…");
    const ask = await asked("Delete the identity provider");
    expect(ask.textContent).toContain("keep their accounts, with no way in");
    expect(ask.textContent).toContain("stored client secret is deleted");
    await press("Keep");
    await waitFor(() => expect(ask.isConnected).toBe(false), { timeout: 5000 });
    expect(document.activeElement === screen.getByRole("button", { name: "Delete…" })).toBe(true);
    expect(await getSsoProvider(backend.t.db, w.org.id)).toBeDefined();
    expect(toasted()).toBeUndefined();
    await press("Delete…");
    await asked("Delete the identity provider");
    await press("Delete provider");
    await within(await region()).findByRole(
      "heading",
      { name: "No identity provider yet" },
      { timeout: 5000 },
    );
    await waitFor(() => expect(toasted()).toBe("Deleted the identity provider."), {
      timeout: 5000,
    });
    expect(await getSsoProvider(backend.t.db, w.org.id)).toBeUndefined();
  });
});
