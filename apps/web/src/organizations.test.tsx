import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createProject,
  createSsoProvider,
  deleteProject,
  getOrganization,
  setSsoMembership,
  signInSso,
  updateSsoProvider,
} from "@orch/db";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/organizations";
});
afterEach(cleanup);

async function world(name = "Acme") {
  const org = await backend.organization(name);
  const as = (role: "owner" | "admin" | "member" | "viewer") =>
    backend.signIn(`${role} of ${org.slug}`, { orgRoles: { [org.id]: role }, projectRoles: {} });
  const [owner, admin, member, viewer] = [
    await as("owner"),
    await as("admin"),
    await as("member"),
    await as("viewer"),
  ];
  const platform = await backend.signIn(`platform of ${org.slug}`);
  backend.makePlatformAdmin(platform.user.gitlabId ?? 0);
  return { org, owner, admin, member, viewer, platform };
}

const section = (name: string) => screen.findByRole("region", { name }, { timeout: 5000 });
const press = async (name: string | RegExp) =>
  userEvent.setup().click(await screen.findByRole("button", { name }, { timeout: 5000 }));
const fill = async (label: string | RegExp, text: string) => {
  const input = await screen.findByLabelText(label, {}, { timeout: 5000 });
  await userEvent.setup().clear(input);
  await userEvent.setup().type(input, text);
};
const controls = () => screen.queryAllByRole("button").map((b) => b.textContent);

describe("the organizations page", () => {
  test("a member or a viewer reads what the organization is and nothing more", async () => {
    const w = await world();
    for (const who of [w.member, w.viewer]) {
      mount(who.client);
      const here = await section("This organization");
      await within(here).findByText(w.org.slug, {}, { timeout: 5000 });
      expect(here.textContent).toContain("Acme");
      expect(screen.queryByRole("region", { name: "Members" })).toBeNull();
      expect(screen.queryByRole("region", { name: "Create an organization" })).toBeNull();
      expect(controls().filter((c) => /rename|delete|create/i.test(c ?? ""))).toEqual([]);
      cleanup();
    }
  });

  test("an admin renames it; the slug and the group are shown and not offered for change", async () => {
    const w = await world();
    mount(w.admin.client);
    const here = await section("This organization");
    expect(within(here).queryByLabelText(/slug/i)).toBeNull();
    await fill("Name", "Acme Ltd");
    await press("Rename");
    await within(await section("This organization")).findByText("Acme Ltd", {}, { timeout: 5000 });
    expect((await getOrganization(backend.t.db, w.org.id))?.name).toBe("Acme Ltd");
    expect(w.org.slug).toBeTruthy();
    // an admin may not delete it, and the page does not offer it
    expect(controls().filter((c) => /delete/i.test(c ?? ""))).toEqual([]);
  });

  test("an owner deletes it only by typing its slug; what it removes and what blocks it is said first", async () => {
    const w = await world();
    const project = await createProject(backend.t.db, { organizationId: w.org.id, name: "p" });
    mount(w.owner.client);
    await press("Delete organization…");
    const text = (await section("This organization")).textContent ?? "";
    for (const what of ["variables", "pools", "cost limits", "policy sets", "audit"]) {
      expect(text).toContain(what);
    }
    for (const what of ["projects", "connections", "notification sinks", "identity provider"]) {
      expect(text).toContain(what);
    }
    const confirm = await screen.findByRole("button", { name: "Delete organization" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await fill(`Type ${w.org.slug} to confirm`, w.org.slug.slice(0, -1));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await fill(`Type ${w.org.slug} to confirm`, w.org.slug);
    expect((confirm as HTMLButtonElement).disabled).toBe(false);

    // refused while a project is there: the API's answer is shown, and nothing is deleted
    await userEvent.setup().click(confirm);
    expect((await screen.findByRole("alert", {}, { timeout: 5000 })).textContent).toContain(
      "projects",
    );
    expect(await getOrganization(backend.t.db, w.org.id)).toBeDefined();

    await deleteProject(backend.t.db, w.org.id, project.id);
    await userEvent
      .setup()
      .click(await screen.findByRole("button", { name: "Delete organization" }));
    await waitFor(
      async () => expect(await getOrganization(backend.t.db, w.org.id)).toBeUndefined(),
      {
        timeout: 5000,
      },
    );
    await screen.findByText(/not in an organization/, {}, { timeout: 5000 });
  });

  test("keeping it changes nothing", async () => {
    const w = await world();
    mount(w.owner.client);
    await press("Delete organization…");
    await press("Keep");
    await screen.findByRole("button", { name: "Delete organization…" }, { timeout: 5000 });
    expect(await getOrganization(backend.t.db, w.org.id)).toBeDefined();
  });

  test("a platform admin creates one, is told it will not show until they hold a role in it, and a taken slug is said", async () => {
    const w = await world();
    mount(w.platform.client);
    await section("Create an organization");
    expect(screen.queryByRole("region", { name: "This organization" })).toBeNull();
    await fill("Name", "Fresh");
    await fill("Slug", "fresh-one");
    await fill("GitLab group ID", "4242");
    await press("Create organization");
    const status = await screen.findByRole("status", {}, { timeout: 5000 });
    expect(status.textContent).toContain("Fresh");
    expect(status.textContent).toContain("GitLab group");
    const made = await backend.t.db.query.organizations.findFirst({
      where: (o, { eq }) => eq(o.slug, "fresh-one"),
    });
    expect(made).toMatchObject({ name: "Fresh", gitlabGroupId: 4242 });

    await fill("Name", "Again");
    await fill("Slug", "fresh-one");
    await fill("GitLab group ID", "4243");
    await press("Create organization");
    expect((await screen.findByRole("alert", {}, { timeout: 5000 })).textContent).toContain("slug");
  });

  test("nobody but a platform admin sees the form to create one", async () => {
    const w = await world();
    for (const who of [w.owner, w.admin, w.member, w.viewer]) {
      mount(who.client);
      await section("This organization");
      expect(screen.queryByRole("region", { name: "Create an organization" })).toBeNull();
      cleanup();
    }
  });

  test("the switcher and the page pick up an organization once the person holds a role in it", async () => {
    const platform = await backend.signIn("platform on its own");
    backend.makePlatformAdmin(platform.user.gitlabId ?? 0);
    const created = await backend.organization("Brand new");
    const view = mount(platform.client);
    await section("Create an organization");
    await view.settled(); // an invalidation that meets the first fetch in flight joins it, and gets the answer from before the roles
    expect(screen.queryByText("Brand new")).toBeNull();
    backend.setRoles(platform.user.gitlabId ?? 0, {
      orgRoles: { [created.id]: "admin" },
      projectRoles: {},
    });
    await view.queries.invalidateQueries({ queryKey: ["orgs"] });
    const here = await section("This organization");
    await within(here).findByText("Brand new", {}, { timeout: 5000 });
    expect(document.querySelector(".org")?.textContent).toContain("Brand new");
  });

  test("someone in no organization is told what the page is for", async () => {
    const lone = await backend.signIn("nobody at all");
    mount(lone.client);
    await screen.findByText(/not in an organization/, {}, { timeout: 5000 });
    expect(screen.queryByRole("region", { name: "Create an organization" })).toBeNull();
  });
});

describe("the members an organization has through its identity provider", () => {
  const join = async (
    providerId: string,
    username: string,
    role: "viewer" | "member" | "admin",
  ) => {
    const who = await signInSso(backend.t.db, providerId, {
      subject: `sub-${username}`,
      email: `${username}@acme.example`,
      username,
      name: `${username.toUpperCase()} Person`,
    });
    await setSsoMembership(backend.t.db, who.id, providerId, role, 3_600_000);
  };

  test("an admin reads who holds a role and until when, with no email, and is told GitLab's members are not listed", async () => {
    const w = await world();
    const p = await createSsoProvider(backend.t.db, backend.keys, {
      organizationId: w.org.id,
      issuer: "https://idp.example.com/realms/acme",
      clientId: "orch",
      clientSecret: "idp-client-SECRET-CANARY-6641",
      emailDomains: ["acme.example"],
      roleMap: [{ claim: "groups", value: "all", role: "viewer" }],
    });
    await updateSsoProvider(backend.t.db, backend.keys, w.org.id, { enabled: true });
    await join(p.id, "bea", "member");
    await join(p.id, "ada", "admin");
    mount(w.admin.client);
    const members = await section("Members");
    await within(members).findByText("ada", {}, { timeout: 5000 });
    const rows = within(members).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("ada"),
      expect.stringContaining("bea"),
    ]);
    expect(rows[0]?.textContent).toContain("admin");
    expect(rows[1]?.textContent).toContain("member");
    expect(members.textContent).not.toContain("acme.example");
    expect(members.textContent).toContain("GitLab group");
  });

  test("with none it says so, and a member never sees the section", async () => {
    const w = await world();
    mount(w.admin.client);
    const members = await section("Members");
    await within(members).findByText(/Nobody holds a role through/, {}, { timeout: 5000 });
    cleanup();
    mount(w.member.client);
    await section("This organization");
    expect(screen.queryByRole("region", { name: "Members" })).toBeNull();
  });
});
