import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createSsoProvider, getSsoProvider, openSsoSecret } from "@orch/db";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";

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

describe("the single sign-on section of the settings page", () => {
  test("an owner or an admin of an organization with none is told so; only an owner can set one up", async () => {
    const w = await world();
    mount(w.admin.client);
    let section = await region();
    await within(section).findByText("No identity provider yet.", {}, { timeout: 5000 });
    expect(within(section).queryByRole("button", { name: /Set up/ })).toBeNull();
    expect(section.textContent).toContain("Only an owner can change it");
    cleanup();
    mount(w.owner.client);
    section = await region();
    await within(section).findByRole("button", { name: "Set up…" }, { timeout: 5000 });
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
    expect(section.textContent).toContain("acme.example");
    expect(section.textContent).toContain("platform");
    expect(section.textContent).toContain("Off");
    expect(section.textContent).toContain("never shown");
    expect(section.textContent).not.toContain(SECRET);
    expect(within(section).queryAllByRole("button")).toEqual([]);
  });

  test("an owner sets one up: it starts off, and the secret typed is stored and shown nowhere", async () => {
    const w = await world();
    mount(w.owner.client);
    await press("Set up…");
    await fill("Issuer", ISSUER);
    await fill("Client ID", "orch");
    await fill("Client secret", SECRET);
    await fill("Email domains", "ACME.example");
    await fill("Rule 1 value", "platform");
    await userEvent.setup().selectOptions(screen.getByLabelText("Rule 1 role"), "admin");
    await press("Set up");
    const section = await region();
    await within(section).findByText("Off", {}, { timeout: 5000 });
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

  test("what the API refuses is said, and nothing is made", async () => {
    const w = await world();
    mount(w.owner.client);
    await press("Set up…");
    await fill("Issuer", "https://idp.example.com/realms/acme?x=1");
    await fill("Client ID", "orch");
    await fill("Client secret", SECRET);
    await fill("Rule 1 value", "platform");
    await press("Set up");
    expect((await screen.findByRole("alert", {}, { timeout: 5000 })).textContent).toBeTruthy();
    expect(await getSsoProvider(backend.t.db, w.org.id)).toBeUndefined();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("it is turned on and off; one with no domain cannot be turned on, and the page says why", async () => {
    const w = await world({ provider: true, domains: [] });
    mount(w.owner.client);
    const section = await region();
    await within(section).findByText(ISSUER, {}, { timeout: 5000 });
    await press("Turn on");
    expect((await screen.findByRole("alert", {}, { timeout: 5000 })).textContent).toContain(
      "at least one email domain",
    );
    expect((await getSsoProvider(backend.t.db, w.org.id))?.enabled).toBe(false);
    cleanup();

    const ready = await world({ provider: true });
    mount(ready.owner.client);
    await press("Turn on");
    await screen.findByRole("button", { name: "Turn off" }, { timeout: 5000 });
    expect((await getSsoProvider(backend.t.db, ready.org.id))?.enabled).toBe(true);
    await press("Turn off");
    await screen.findByRole("button", { name: "Turn on" }, { timeout: 5000 });
    expect((await getSsoProvider(backend.t.db, ready.org.id))?.enabled).toBe(false);
  });

  test("the test says what it found, or why it could not", async () => {
    const w = await world({ provider: true });
    mount(w.owner.client);
    await press("Test");
    await screen.findByText(/1 signing key/, {}, { timeout: 5000 });
    idp.down = true;
    await press("Test");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("answered 500"), {
      timeout: 5000,
    });
  });

  test("a change keeps the secret unless a new one is typed, and the issuer is not offered for change", async () => {
    const w = await world({ provider: true });
    mount(w.owner.client);
    await press("Edit…");
    const form = await screen.findByRole("form", { name: "Identity provider" }, { timeout: 5000 });
    expect(within(form).queryByLabelText("Issuer")).toBeNull();
    expect(form.textContent).toContain(ISSUER);
    const id = userEvent.setup();
    const clientId = within(form).getByLabelText("Client ID");
    await id.clear(clientId);
    await id.type(clientId, "orch-2");
    expect((within(form).getByLabelText("Client secret") as HTMLInputElement).value).toBe("");
    await press("Save changes");
    await within(await region()).findByText("orch-2", {}, { timeout: 5000 });
    const before = await getSsoProvider(backend.t.db, w.org.id);
    expect(before?.clientId).toBe("orch-2");
    expect(await openSsoSecret(backend.t.db, backend.keys, before?.id ?? "")).toBe(SECRET);

    await press("Edit…");
    await fill("Client secret", NEW_SECRET);
    await press("Save changes");
    await within(await region()).findByRole("button", { name: "Edit…" }, { timeout: 5000 });
    await waitFor(async () =>
      expect(await openSsoSecret(backend.t.db, backend.keys, before?.id ?? "")).toBe(NEW_SECRET),
    );
    expect(document.body.textContent).not.toContain(NEW_SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("deleting asks first, and keeping it changes nothing", async () => {
    const w = await world({ provider: true });
    mount(w.owner.client);
    await press("Delete…");
    await press("Keep");
    await screen.findByRole("button", { name: "Edit…" }, { timeout: 5000 });
    expect(await getSsoProvider(backend.t.db, w.org.id)).toBeDefined();
    await press("Delete…");
    await press("Delete provider");
    await within(await region()).findByText("No identity provider yet.", {}, { timeout: 5000 });
    expect(await getSsoProvider(backend.t.db, w.org.id)).toBeUndefined();
  });
});
