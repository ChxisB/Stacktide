import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import {
  createSsoProvider,
  linkSsoIdentity,
  listIdentities,
  setSsoMembership,
  ssoRolesOf,
  updateSsoProvider,
  userIdentities,
} from "@orch/db";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, clientVia, mount, pathOf, startBackend } from "./testing";

const SUB = "idp-subject-CANARY-6671";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/settings";
});
afterEach(cleanup);

/** Someone with a GitLab role in one organization and an identity at another's provider. */
async function world() {
  const home = await backend.organization("Home");
  const acme = await backend.organization("Acme Corp");
  const me = await backend.signIn("Ada", { orgRoles: { [home.id]: "viewer" }, projectRoles: {} });
  const provider = await createSsoProvider(backend.t.db, backend.keys, {
    organizationId: acme.id,
    issuer: "https://idp.example.com/realms/acme",
    clientId: "orch",
    clientSecret: "idp-client-SECRET-CANARY-6672",
    emailDomains: ["acme.example"],
    roleMap: [{ claim: "groups", value: "all", role: "viewer" }],
  });
  await updateSsoProvider(backend.t.db, backend.keys, acme.id, { enabled: true });
  await linkSsoIdentity(backend.t.db, me.user.id, provider.id, {
    subject: SUB,
    email: "ada@acme.example",
  });
  await setSsoMembership(backend.t.db, me.user.id, provider.id, "viewer", 3_600_000);
  return { home, acme, me, provider };
}

const section = () => screen.findByRole("region", { name: "Sign-in methods" }, { timeout: 5000 });
const rowsOf = (here: HTMLElement) => within(here).getAllByRole("row").slice(1);
const press = async (within_: HTMLElement, name: string | RegExp) =>
  userEvent.setup().click(await within(within_).findByRole("button", { name }, { timeout: 5000 }));

describe("the sign-in methods on the settings page", () => {
  test("lists GitLab and the organization's provider, with no way to give up GitLab and never the subject", async () => {
    const w = await world();
    mount(w.me.client);
    const here = await section();
    await within(here).findByText(/Acme Corp/, {}, { timeout: 5000 });
    const rows = rowsOf(here);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("GitLab");
    expect(within(rows[0] as HTMLElement).queryByRole("button")).toBeNull();
    expect(rows[1]?.textContent).toContain(w.acme.slug);
    expect(rows[1]?.textContent).toContain("ada@acme.example");
    expect(within(rows[1] as HTMLElement).getByRole("button", { name: "Unlink…" })).toBeTruthy();
    expect(here.textContent).not.toContain(SUB);
  });

  test("a GitHub way in is listed as GitHub, with no way to give it up and never the GitHub id", async () => {
    const w = await world();
    await backend.t.db
      .insert(userIdentities)
      .values({ userId: w.me.user.id, provider: "github", subject: "90210424" });
    mount(w.me.client);
    const here = await section();
    await within(here).findByText(/Acme Corp/, {}, { timeout: 5000 });
    const github = rowsOf(here).find((r) => r.textContent?.startsWith("GitHub"));
    expect(github).toBeTruthy();
    expect(within(github as HTMLElement).queryByRole("button")).toBeNull();
    expect(here.textContent).not.toContain("90210424");
  });

  test("giving one up asks first; keeping changes nothing; confirming ends it and the role it gave", async () => {
    const w = await world();
    mount(w.me.client);
    const here = await section();
    await within(here).findByText(/Acme Corp/, {}, { timeout: 5000 });
    await press(here, "Unlink…");
    await press(here, "Keep");
    await within(here).findByRole("button", { name: "Unlink…" });
    expect(await listIdentities(backend.t.db, w.me.user.id)).toHaveLength(2);

    await press(here, "Unlink…");
    await press(here, "Unlink");
    // the page reads everything again once a role is gone, so `here` may be a new element by now
    await waitFor(() => expect(screen.queryByText(/Acme Corp/)).toBeNull(), { timeout: 5000 });
    expect(await listIdentities(backend.t.db, w.me.user.id)).toHaveLength(1);
    expect(await ssoRolesOf(backend.t.db, w.me.user.id)).toEqual({});
  });

  test("someone with only GitLab is offered nothing to give up", async () => {
    const home = await backend.organization("Only");
    const solo = await backend.signIn("Solo", {
      orgRoles: { [home.id]: "viewer" },
      projectRoles: {},
    });
    mount(solo.client);
    const here = await section();
    await within(here).findByText("GitLab", {}, { timeout: 5000 });
    expect(rowsOf(here)).toHaveLength(1);
    expect(within(here).queryByRole("button", { name: /unlink/i })).toBeNull();
  });

  test("what the API refuses with is shown, and nothing changes", async () => {
    const w = await world();
    const client = clientVia(backend.api, w.me.cookie, async (request, send) =>
      request.method === "DELETE" && pathOf(request).startsWith("/auth/identities/")
        ? Response.json(
            {
              type: "about:blank",
              title: "Conflict",
              status: 409,
              code: "last_identity",
              detail: "This is your only way to sign in",
            },
            { status: 409, headers: { "content-type": "application/problem+json" } },
          )
        : send(),
    );
    mount(client);
    const here = await section();
    await within(here).findByText(/Acme Corp/, {}, { timeout: 5000 });
    await press(here, "Unlink…");
    await press(here, "Unlink");
    expect((await within(here).findByRole("alert", {}, { timeout: 5000 })).textContent).toContain(
      "only way to sign in",
    );
    expect(await listIdentities(backend.t.db, w.me.user.id)).toHaveLength(2);
  });

  test("linking asks the API to start it by the organization's slug, then goes where it says", async () => {
    const w = await world();
    const asked: string[] = [];
    const client = clientVia(backend.api, w.me.cookie, async (request, send) => {
      if (request.method !== "POST" || !pathOf(request).startsWith("/auth/sso/")) return send();
      asked.push(`${pathOf(request)}${new URL(request.url).search}`);
      return Response.json({ location: "https://idp.example.com/auth?state=s" });
    });
    const go = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      mount(client);
      const here = await section();
      expect(within(here).queryByRole("button", { name: "Link with single sign-on" })).toBeNull();
      await userEvent
        .setup()
        .type(await within(here).findByLabelText("Organization slug"), "  a b  ");
      expect(here.textContent).toContain("whoever runs it can sign in as you");
      await press(here, "Link with single sign-on");
      await waitFor(() => expect(go).toHaveBeenCalledWith("https://idp.example.com/auth?state=s"));
      expect(asked).toEqual(["/auth/sso/a%20b/link?return_to=%2F%23%2Fsettings"]);
    } finally {
      go.mockRestore();
    }
  });

  test("an organization that has no provider is said so in the page, and the browser stays", async () => {
    const w = await world();
    const client = clientVia(backend.api, w.me.cookie, async (request, send) =>
      request.method === "POST" && pathOf(request).startsWith("/auth/sso/")
        ? Response.json(
            {
              type: "about:blank",
              title: "Not found",
              status: 404,
              code: "not_found",
              detail: "Single sign-on not found",
            },
            { status: 404, headers: { "content-type": "application/problem+json" } },
          )
        : send(),
    );
    const go = spyOn(window.location, "assign").mockImplementation(() => {});
    try {
      mount(client);
      const here = await section();
      await userEvent.setup().type(await within(here).findByLabelText("Organization slug"), "nope");
      await press(here, "Link with single sign-on");
      expect((await within(here).findByRole("alert", {}, { timeout: 5000 })).textContent).toContain(
        "Single sign-on not found",
      );
      expect(go).not.toHaveBeenCalled();
    } finally {
      go.mockRestore();
    }
  });
});
