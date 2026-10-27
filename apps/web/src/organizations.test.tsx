import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createDnsZone,
  createProject,
  createSsoProvider,
  deleteProject,
  getOrganization,
  listDnsZones,
  setSsoMembership,
  signInSso,
  updateSsoProvider,
} from "@orch/db";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, inMain, mount, startBackend } from "./testing";

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
const toasted = () => document.querySelector(".toast-text")?.textContent ?? "";
// a question asked in a dialog; a destructive one is an alertdialog
const asked = (name: string) => screen.findByRole("alertdialog", { name }, { timeout: 5000 });

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
    // the result is a toast, in a sentence
    await waitFor(() => expect(toasted()).toBe("Renamed the organization to Acme Ltd."));
    expect((await getOrganization(backend.t.db, w.org.id))?.name).toBe("Acme Ltd");
    expect(w.org.slug).toBeTruthy();
    // an admin may not delete it, and the page does not offer it
    expect(controls().filter((c) => /delete/i.test(c ?? ""))).toEqual([]);
  });

  test("an owner deletes it only by typing its slug, in a dialog; what it removes and what blocks it is said first", async () => {
    const w = await world();
    const project = await createProject(backend.t.db, { organizationId: w.org.id, name: "p" });
    mount(w.owner.client);
    await press("Delete organization…");
    const dialog = await asked("Delete Acme");
    const text = dialog.textContent ?? "";
    for (const what of ["variables", "pools", "cost limits", "policy sets", "audit"]) {
      expect(text).toContain(what);
    }
    for (const what of ["projects", "connections", "notification sinks", "identity provider"]) {
      expect(text).toContain(what);
    }
    // what it removes is said as a warning, which is not an alert: the only alert is an answer
    expect(within(dialog).queryByRole("alert")).toBeNull();
    const confirm = within(dialog).getByRole("button", { name: "Delete organization" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await fill(`Type ${w.org.slug} to confirm`, w.org.slug.slice(0, -1));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await fill(`Type ${w.org.slug} to confirm`, w.org.slug);
    expect((confirm as HTMLButtonElement).disabled).toBe(false);

    // refused while a project is there: the API's answer is shown in the dialog, and nothing is deleted
    await userEvent.setup().click(confirm);
    const refusal = await within(dialog).findByRole("alert", {}, { timeout: 5000 });
    expect(refusal.textContent).toContain("projects");
    expect(await getOrganization(backend.t.db, w.org.id)).toBeDefined();

    await deleteProject(backend.t.db, w.org.id, project.id);
    await userEvent
      .setup()
      .click(await within(dialog).findByRole("button", { name: "Delete organization" }));
    await waitFor(
      async () => expect(await getOrganization(backend.t.db, w.org.id)).toBeUndefined(),
      {
        timeout: 5000,
      },
    );
    await screen.findByText(/not in an organization/, {}, { timeout: 5000 });
    expect(toasted()).toBe("Deleted Acme.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  test("keeping it changes nothing: Keep and Esc both close the dialog, and focus is back on the button", async () => {
    const w = await world();
    mount(w.owner.client);
    const opener = await screen.findByRole(
      "button",
      { name: "Delete organization…" },
      { timeout: 5000 },
    );
    const user = userEvent.setup();
    await user.click(opener);
    await asked("Delete Acme");
    await fill(`Type ${w.org.slug} to confirm`, w.org.slug);
    await press("Keep");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(opener);

    // what was typed is not kept for the next time
    await user.click(opener);
    await asked("Delete Acme");
    expect(
      ((await screen.findByLabelText(`Type ${w.org.slug} to confirm`)) as HTMLInputElement).value,
    ).toBe("");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
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
    const status = await inMain().findByRole("status", {}, { timeout: 5000 });
    expect(status.textContent).toContain("Fresh");
    expect(status.textContent).toContain("GitLab group or GitHub organization");
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

  test("the form says what the slug and the links are before anything is sent, and checks the slug as it is typed", async () => {
    const w = await world();
    mount(w.platform.client);
    const form = await screen.findByRole("form", { name: "New organization" }, { timeout: 5000 });
    // the hints are there from the start and tied to their fields
    const slug = within(form).getByLabelText("Slug");
    expect(slug.getAttribute("aria-invalid")).toBeNull();
    const hint = (field: HTMLElement) =>
      document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent;
    expect(hint(slug)).toBe("Lowercase letters, digits and dashes. Cannot be changed afterwards.");
    expect(hint(within(form).getByLabelText("GitLab group ID"))).toBe(
      "Cannot be changed afterwards.",
    );
    expect(hint(within(form).getByLabelText("GitHub organization ID"))).toBe(
      "Cannot be changed afterwards.",
    );
    const make = within(form).getByRole("button", { name: "Create organization" });

    // a slug the API would refuse is said at once, by its rule, and is not sent
    await fill("Name", "Fresh");
    await fill("GitLab group ID", "4242");
    for (const bad of ["Fresh One", "-fresh", "fresh-", "fresh--one"]) {
      await fill("Slug", bad);
      expect(slug.getAttribute("aria-invalid")).toBe("true");
      expect(hint(slug)).toBe("Use lowercase letters and digits, separated by single dashes.");
      expect((make as HTMLButtonElement).disabled).toBe(true);
    }
    await fill("Slug", "fresh-one");
    expect(slug.getAttribute("aria-invalid")).toBeNull();
    expect(hint(slug)).toContain("Cannot be changed afterwards");
    expect((make as HTMLButtonElement).disabled).toBe(false);
  });

  test("a refused create is a callout that says why, and the form keeps what was typed", async () => {
    const w = await world();
    mount(w.platform.client);
    await fill("Name", "Dupe");
    await fill("Slug", w.org.slug);
    await fill("GitLab group ID", "5151");
    await press("Create organization");
    const alert = await screen.findByRole("alert", {}, { timeout: 5000 });
    expect(alert.textContent).toContain("slug");
    expect(alert.classList.contains("callout")).toBe(true);
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Dupe");
  });

  test("an organization may be linked to a GitHub organization alone, and then says so (FRG-34)", async () => {
    const w = await world();
    mount(w.platform.client);
    await section("Create an organization");
    await fill("Name", "Hubbed");
    await fill("Slug", "hubbed");
    await fill("GitHub organization ID", "7300000001");
    await press("Create organization");
    await inMain().findByRole("status", {}, { timeout: 5000 });
    const made = await backend.t.db.query.organizations.findFirst({
      where: (o, { eq }) => eq(o.slug, "hubbed"),
    });
    expect(made).toMatchObject({ gitlabGroupId: null, githubOrgId: 7300000001 });
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
    // an empty state: a heading that says it, and a line that says when someone will appear
    await within(members).findByRole(
      "heading",
      { name: "Nobody holds a role through the identity provider right now" },
      { timeout: 5000 },
    );
    expect(members.textContent).toContain(
      "People appear here once they sign in through the identity provider.",
    );
    expect(within(members).queryByRole("table")).toBeNull();
    cleanup();
    mount(w.member.client);
    await section("This organization");
    expect(screen.queryByRole("region", { name: "Members" })).toBeNull();
  });
});

// DNS-15: the zone claims
describe("the DNS zones an organization has claimed", () => {
  const claims = (orgId: string) => listDnsZones(backend.t.db, orgId, { limit: 100 });
  const claim = (orgId: string, projectId: string, zone: string, stack = "example-com") =>
    createDnsZone(backend.t.db, { organizationId: orgId, projectId, zone, stack });
  const select = async (label: string, option: string) =>
    userEvent
      .setup()
      .selectOptions(await screen.findByLabelText(label, {}, { timeout: 5000 }), option);

  test("anyone in the organization reads the claims; only an admin is offered to make or release one", async () => {
    const w = await world();
    const project = await createProject(backend.t.db, { organizationId: w.org.id, name: "web" });
    await claim(w.org.id, project.id, "example.com");
    for (const who of [w.member, w.viewer]) {
      mount(who.client);
      const here = await section("DNS zones");
      const row = await within(here).findByRole("row", { name: /example\.com/ }, { timeout: 5000 });
      expect(row.textContent).toContain("web");
      expect(row.textContent).toContain("example-com");
      expect(screen.queryByRole("button", { name: /claim|release/i })).toBeNull();
      expect(within(here).queryByLabelText("Zone")).toBeNull();
      cleanup();
    }
    mount(w.admin.client);
    await screen.findByRole("button", { name: "Release… example.com" }, { timeout: 5000 });
    await screen.findByRole("button", { name: "Claim zone" }, { timeout: 5000 });
  });

  test("with no claim it says so, and says a claim is a guard and the token is the boundary", async () => {
    const w = await world();
    await createProject(backend.t.db, { organizationId: w.org.id, name: "web" });
    mount(w.viewer.client);
    const here = await section("DNS zones");
    await within(here).findByRole("heading", { name: "No zone is claimed yet" }, { timeout: 5000 });
    expect(here.textContent).toContain("guard");
    expect(here.textContent).toContain("token");
    // a reader is told who can claim one; an admin is told where
    expect(here.textContent).toContain("An admin can claim a zone for a project's stack.");
    cleanup();
    const admin = await world("Beta");
    await createProject(backend.t.db, { organizationId: admin.org.id, name: "web" });
    mount(admin.admin.client);
    const mine = await section("DNS zones");
    await within(mine).findByRole("heading", { name: "No zone is claimed yet" }, { timeout: 5000 });
    expect(mine.textContent).toContain(
      "Claim a zone below to say which project's stack may manage it.",
    );
  });

  test("an admin claims a zone for the project they choose, and it is there for everyone", async () => {
    const w = await world();
    await createProject(backend.t.db, { organizationId: w.org.id, name: "alpha" });
    const beta = await createProject(backend.t.db, { organizationId: w.org.id, name: "beta" });
    mount(w.admin.client);
    await fill("Zone", "example.com");
    await select("Project", "beta");
    await fill("Stack", "example-com");
    await press("Claim zone");
    const row = await within(await section("DNS zones")).findByRole(
      "row",
      { name: /example\.com/ },
      { timeout: 5000 },
    );
    expect(row.textContent).toContain("beta");
    await waitFor(() => expect(toasted()).toBe("Claimed example.com."));
    expect((await claims(w.org.id)).map((c) => [c.zone, c.projectId, c.stack])).toEqual([
      ["example.com", beta.id, "example-com"],
    ]);
    // the form is empty again, for the next one
    expect(((await screen.findByLabelText("Zone")) as HTMLInputElement).value).toBe("");
  });

  test("a zone that is claimed already is said so, and the first claim stays", async () => {
    const w = await world();
    const project = await createProject(backend.t.db, { organizationId: w.org.id, name: "web" });
    await claim(w.org.id, project.id, "example.com", "first");
    mount(w.admin.client);
    await fill("Zone", "example.com");
    await fill("Stack", "second");
    await press("Claim zone");
    expect((await screen.findByRole("alert", {}, { timeout: 5000 })).textContent).toContain(
      "claimed already",
    );
    expect((await claims(w.org.id)).map((c) => c.stack)).toEqual(["first"]);
  });

  test("a name that is not a zone, or a stack, is said at once and is not sent", async () => {
    const w = await world();
    await createProject(backend.t.db, { organizationId: w.org.id, name: "web" });
    mount(w.admin.client);
    const button = (await screen.findByRole(
      "button",
      { name: "Claim zone" },
      { timeout: 5000 },
    )) as HTMLButtonElement;
    const zone = screen.getByLabelText("Zone");
    const stack = screen.getByLabelText("Stack");
    const line = (field: HTMLElement) =>
      document.getElementById(field.getAttribute("aria-describedby") ?? "")?.textContent;
    expect(button.disabled).toBe(true);
    // nothing typed is nothing wrong: the line is a hint, and the field is not marked
    expect(zone.getAttribute("aria-invalid")).toBeNull();
    expect(line(zone)).toBe("The domain the stack manages.");
    expect(line(stack)).toBe("Lowercase letters, digits and dashes, up to 63 characters.");
    await fill("Zone", "Not A Zone");
    await fill("Stack", "example-com");
    expect(button.disabled).toBe(true);
    expect(zone.getAttribute("aria-invalid")).toBe("true");
    expect(line(zone)).toBe(
      "Enter a domain such as example.com: lowercase letters, digits and dashes, with at least one dot.",
    );
    expect(stack.getAttribute("aria-invalid")).toBeNull();
    await fill("Zone", "example.com");
    expect(zone.getAttribute("aria-invalid")).toBeNull();
    await fill("Stack", "Not A Stack");
    expect(button.disabled).toBe(true);
    expect(stack.getAttribute("aria-invalid")).toBe("true");
    expect(line(stack)).toBe(
      "Use lowercase letters, digits and dashes. Start and end with a letter or digit.",
    );
    await fill("Stack", "example-com");
    expect(stack.getAttribute("aria-invalid")).toBeNull();
    expect(button.disabled).toBe(false);
  });

  test("releasing asks first, in a dialog; keeping changes nothing, and confirming removes the claim", async () => {
    const w = await world();
    const project = await createProject(backend.t.db, { organizationId: w.org.id, name: "web" });
    await claim(w.org.id, project.id, "example.com");
    mount(w.admin.client);
    const opener = await screen.findByRole(
      "button",
      { name: "Release… example.com" },
      { timeout: 5000 },
    );
    const user = userEvent.setup();
    await user.click(opener);
    const dialog = await asked("Release example.com");
    expect(dialog.textContent).toContain("stops being managed");
    expect(dialog.textContent).toContain("Its records at the provider are not touched.");
    await press("Keep");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(await claims(w.org.id)).toHaveLength(1);

    await user.click(opener);
    await asked("Release example.com");
    await press("Release example.com");
    await within(await section("DNS zones")).findByRole(
      "heading",
      { name: "No zone is claimed yet" },
      { timeout: 5000 },
    );
    expect(await claims(w.org.id)).toEqual([]);
    expect(toasted()).toBe("Released example.com.");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    // the row that had the focus is gone, so the focus goes to the page's main and not to nowhere
    expect(document.activeElement).toBe(document.getElementById("main"));
  });

  test("an admin with no project is sent to import one, and is not offered a form that cannot work", async () => {
    const w = await world();
    mount(w.admin.client);
    const here = await section("DNS zones");
    await within(here).findByRole("link", { name: /import/i }, { timeout: 5000 });
    expect(screen.queryByRole("button", { name: "Claim zone" })).toBeNull();
  });
});
