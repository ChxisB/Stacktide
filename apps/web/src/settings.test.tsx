import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { apiTokens, auditEvents } from "@orch/db";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eq } from "drizzle-orm";
import { newQueryClient } from "./app";
import { type Backend, clientVia, mount, pathOf, startBackend, visibleText } from "./testing";
import { must, scene as sceneOn } from "./variables.fixture";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/settings";
  try {
    localStorage.clear();
  } catch {
    // the page copes without it
  }
});

type Scene = Awaited<ReturnType<typeof sceneOn>>;

/** The scene's connection to a mock GitLab, made through the API. */
async function connect(s: Scene) {
  const mock = backend.gitlab();
  const connection = must(
    await s.admin.client.organizations({ orgId: s.org.id }).connections.post({
      type: "gitlab",
      name: "Mock GitLab",
      baseUrl: mock.url,
      token: mock.token,
    }),
  );
  return { mock, connection };
}
const connectionsOf = async (s: Scene) =>
  must(
    await s.admin.client
      .organizations({ orgId: s.org.id })
      .connections.get({ query: { limit: 100 } }),
  ).items;
const tokensOf = async (s: Scene) =>
  must(await s.client.tokens.get({ query: { limit: 100 } })).items;
const audited = (action: string, resourceId: string) =>
  backend.t.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, action))
    .then((rows) => rows.filter((r) => r.resourceId === resourceId));

/** Whether a text is anywhere on the screen, in the text or in a field. */
const onPage = (text: string) =>
  (document.body.textContent ?? "").includes(text) ||
  Array.from(document.querySelectorAll("input")).some((i) => i.value.includes(text));
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? undefined;
const statusText = () => document.querySelector('[role="status"]')?.textContent ?? undefined;
const rowOf = (t: HTMLElement, name: string) => {
  const tr = within(t).getByRole("rowheader", { name }).closest("tr");
  if (!tr) throw new Error(`no row for ${name}`);
  return tr;
};
// a role query is slow in happy-dom: give each look time, and keep the cheap probes inside waits
const connections = () => screen.findByRole("table", { name: "Connections" }, { timeout: 5000 });
const tokenTable = () => screen.findByRole("table", { name: "Your API tokens" }, { timeout: 5000 });

describe("the page", () => {
  test("is in the navigation, and says the role in the organization", async () => {
    const s = await sceneOn(backend);
    mount(s.client);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
    const access = await screen.findByRole("region", { name: "Your access" });
    expect(access.textContent).toContain(`Your role in ${s.org.name} is admin.`);
    expect(access.textContent).toContain("GitLab");
  });

  test("a viewer and a member see their role, and no connections, but their tokens", async () => {
    const s = await sceneOn(backend, { reporter: true });
    const viewer = await backend.signIn(`viewer of ${s.org.slug}`, {
      orgRoles: { [s.org.id]: "viewer" },
      projectRoles: {},
    });
    for (const [client, role] of [
      [viewer.client, "viewer"],
      [s.client, "member"],
    ] as const) {
      mount(client);
      const access = await screen.findByRole("region", { name: "Your access" });
      expect(access.textContent).toContain(`is ${role}.`);
      await screen.findByRole("heading", { name: "Your API tokens" });
      expect(screen.queryByRole("heading", { name: "Connections" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Add a connection…" })).toBeNull();
      cleanup();
    }
  });

  test("an error loading it is shown with a way to try again", async () => {
    const s = await sceneOn(backend);
    let fail = true;
    const client = clientVia(backend.api, s.cookie, async (request, send) => {
      if (fail && pathOf(request).endsWith("/access")) {
        return Response.json(
          { type: "about:blank", title: "Unavailable", status: 503, detail: "Try later" },
          { status: 503, headers: { "content-type": "application/problem+json" } },
        );
      }
      return send();
    });
    mount(client);
    await waitFor(() => expect(alertText() !== undefined).toBe(true), { timeout: 5000 });
    fail = false;
    await userEvent.setup().click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("region", { name: "Your access" });
  });
});

describe("connections", () => {
  test("lists them with the address, and shows no token anywhere", async () => {
    const s = await sceneOn(backend);
    const { mock, connection } = await connect(s);
    mount(s.client);
    const row = rowOf(await connections(), "Mock GitLab");
    expect(row.textContent).toContain(mock.url);
    expect(row.textContent).toMatch(/\d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    expect(connection.id).toBeDefined();
    expect(onPage(mock.token)).toBe(false);
  });

  test("tests one, and says who GitLab sees", async () => {
    const s = await sceneOn(backend);
    const { mock, connection } = await connect(s);
    mount(s.client);
    const user = userEvent.setup();
    const test = within(rowOf(await connections(), "Mock GitLab")).getByRole("button", {
      name: "Test Mock GitLab",
    });
    // one word on the page; the whole name stays for assistive technology
    expect(visibleText(test)).toBe("Test");
    await user.click(test);
    await waitFor(() => expect(statusText()?.includes("mock-token-user")).toBe(true), {
      timeout: 5000,
    });
    expect(statusText()).toContain("Scopes: read_api.");
    expect(onPage(mock.token)).toBe(false);
    expect((await audited("connection.test", connection.id)).length).toBe(1);
  });

  test("tests one on an older Community Edition, and says what it lacks", async () => {
    const s = await sceneOn(backend);
    const { mock } = await connect(s);
    mock.setVersion("17.3.2", false);
    mount(s.client);
    const user = userEvent.setup();
    await user.click(
      within(rowOf(await connections(), "Mock GitLab")).getByRole("button", {
        name: "Test Mock GitLab",
      }),
    );
    await waitFor(() => expect(statusText()?.includes("GitLab 17.3.2.")).toBe(true), {
      timeout: 5000,
    });
    expect(statusText()).toContain(
      "Not available here: Hidden variables (needs GitLab 17.4 or later)",
    );
    expect(statusText()).toContain("Environment scopes on group variables");
    expect(statusText()).not.toContain("Cannot be told");
  });

  test("a newer GitLab with a licence it cannot read says which thing it cannot tell", async () => {
    const s = await sceneOn(backend);
    await connect(s);
    mount(s.client);
    const user = userEvent.setup();
    await user.click(
      within(rowOf(await connections(), "Mock GitLab")).getByRole("button", {
        name: "Test Mock GitLab",
      }),
    );
    await waitFor(() => expect(statusText()?.includes("GitLab 18.1.1-ee.")).toBe(true), {
      timeout: 5000,
    });
    expect(statusText()).toContain("Cannot be told: Environment scopes on group variables");
    expect(statusText()).not.toContain("Not available here");
  });

  test("a test that fails says why, in the words the API gives", async () => {
    const s = await sceneOn(backend);
    await connect(s);
    const client = clientVia(backend.api, s.cookie, async (request, send) =>
      request.method === "POST" && pathOf(request).endsWith("/test")
        ? Response.json({ ok: false, reason: "unauthorized", message: "GitLab refused the token" })
        : send(),
    );
    mount(client);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Test Mock GitLab" }));
    await waitFor(() => expect(alertText()).toBe("GitLab refused the token"), { timeout: 5000 });
    expect(statusText()).toBeUndefined();
  });

  test("deletes one only after a confirm, and keeping it deletes nothing", async () => {
    const s = await sceneOn(backend);
    const { connection } = await connect(s);
    mount(s.client);
    const user = userEvent.setup();
    const row = () => rowOf(screen.getByRole("table", { name: "Connections" }), "Mock GitLab");
    await connections();
    await user.click(within(row()).getByRole("button", { name: "Delete…" }));
    expect(within(row()).getByText(/Its stored token is deleted/)).toBeDefined();
    await user.click(within(row()).getByRole("button", { name: "Keep" }));
    expect(within(row()).getByRole("button", { name: "Delete…" })).toBeDefined();
    expect((await connectionsOf(s)).map((c) => c.id)).toEqual([connection.id]);

    await user.click(within(row()).getByRole("button", { name: "Delete…" }));
    await user.click(within(row()).getByRole("button", { name: "Delete Mock GitLab" }));
    await screen.findByText("No connection yet.", undefined, { timeout: 5000 });
    expect(await connectionsOf(s)).toEqual([]);
    expect((await audited("connection.delete", connection.id)).length).toBe(1);
  });

  test("one that a sync target uses is not deleted, and the page says so", async () => {
    const s = await sceneOn(backend);
    const { mock, connection } = await connect(s);
    const gl = mock.addProject({ path: "fx/in-use" });
    must(
      await s.scope["sync-targets"].post({
        name: "main",
        type: "gitlab-variables",
        connectionId: connection.id,
        config: { project: gl.path },
        environmentMapping: { dev: "development" },
      }),
    );
    mount(s.client);
    const user = userEvent.setup();
    await connections();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await user.click(screen.getByRole("button", { name: "Delete Mock GitLab" }));
    await waitFor(() => expect(alertText()).toContain("Sync targets still use this connection"), {
      timeout: 5000,
    });
    expect((await connectionsOf(s)).length).toBe(1);
    expect((await audited("connection.delete", connection.id)).length).toBe(0);
    // keeping it leaves no stale complaint on the row
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(alertText()).toBeUndefined();
  });

  test("a test result is not left standing when a delete is considered", async () => {
    const s = await sceneOn(backend);
    await connect(s);
    mount(s.client);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Test Mock GitLab" }, { timeout: 5000 }),
    );
    await waitFor(() => expect(statusText()?.includes("mock-token-user")).toBe(true), {
      timeout: 5000,
    });
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    expect(statusText()).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Keep" }));
    expect(statusText()).toBeUndefined();
  });

  test("offers only what the actions it was told allow", async () => {
    const s = await sceneOn(backend);
    await connect(s);
    const client = clientVia(backend.api, s.cookie, async (request, send) =>
      pathOf(request).endsWith("/access")
        ? Response.json({ role: "admin", actions: ["organization.read", "connection.read"] })
        : send(),
    );
    mount(client);
    await connections();
    expect(screen.queryByRole("button", { name: "Test Mock GitLab" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a connection…" })).toBeNull();
  });

  test("adds one, and the token is not left on the page", async () => {
    const s = await sceneOn(backend);
    const mock = backend.gitlab();
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByText("No connection yet.");
    await user.click(screen.getByRole("button", { name: "Add a connection…" }));
    const form = await screen.findByRole("form", { name: "Connect GitLab" });
    await user.clear(within(form).getByLabelText("GitLab address"));
    await user.type(within(form).getByLabelText("GitLab address"), mock.url);
    await user.type(within(form).getByLabelText("Access token"), mock.token);
    await user.click(within(form).getByRole("button", { name: "Connect" }));
    await waitFor(
      () => expect(document.querySelector('form[aria-label="Connect GitLab"]') === null).toBe(true),
      { timeout: 5000 },
    );
    const row = rowOf(await connections(), "GitLab");
    expect(row.textContent).toContain(mock.url);
    expect((await connectionsOf(s)).length).toBe(1);
    expect(onPage(mock.token)).toBe(false);
  });

  test("the form can be given up", async () => {
    const s = await sceneOn(backend);
    mount(s.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add a connection…" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("form", { name: "Connect GitLab" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add a connection…" })).toBeDefined();
    expect(await connectionsOf(s)).toEqual([]);
  });
});

describe("API tokens", () => {
  const fill = async (user: ReturnType<typeof userEvent.setup>, name: string, scopes: string) => {
    const form = await screen.findByRole("form", { name: "Create a token" });
    await user.type(within(form).getByLabelText("Name"), name);
    await user.type(within(form).getByLabelText("Scopes"), scopes);
    return form;
  };

  test("says there are none, and the form asks for a name, scopes and a lifetime", async () => {
    const s = await sceneOn(backend);
    mount(s.client);
    await screen.findByText("You have no tokens.");
    const form = screen.getByRole("form", { name: "Create a token" });
    expect(
      within(form)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["7 days", "30 days", "90 days", "365 days"]);
    expect((within(form).getByLabelText("Lasts") as HTMLSelectElement).value).toBe("30");
  });

  test("shows a new token once, in full, and only its start afterwards", async () => {
    const s = await sceneOn(backend);
    const queries = newQueryClient();
    mount(s.client, queries);
    const user = userEvent.setup();
    const form = await fill(user, "ci", "variable.read,  project.read, variable.read");
    await user.selectOptions(within(form).getByLabelText("Lasts"), "90");
    await user.click(within(form).getByRole("button", { name: "Create token" }));

    const fresh = await screen.findByRole("region", { name: "New token" }, { timeout: 5000 });
    const token = (within(fresh).getByLabelText("Token") as HTMLInputElement).value;
    expect(token.length).toBeGreaterThan(20);
    expect(fresh.textContent).toContain("shown this once");
    // in the one field, and nowhere in the text of the page
    expect(
      Array.from(document.querySelectorAll("input")).filter((i) => i.value === token).length,
    ).toBe(1);
    expect(document.body.textContent).not.toContain(token);

    // the list has the start of it, the scopes, and the lifetime asked for
    const [made] = await tokensOf(s);
    expect(made?.name).toBe("ci");
    expect(made?.scopes).toEqual(["variable.read", "project.read"]);
    expect(token.startsWith(made?.prefix ?? "?")).toBe(true);
    expect(Math.round((new Date(made?.expiresAt ?? 0).getTime() - Date.now()) / 86_400_000)).toBe(
      90,
    );
    const row = rowOf(await tokenTable(), "ci");
    expect(row.textContent).toContain(`${made?.prefix}…`);
    expect(row.textContent).toContain("variable.read project.read");
    expect(row.textContent).toContain("Active");
    expect(row.textContent).toContain("Never");

    // not in the caches, and not in the audit trail
    const cached = JSON.stringify([
      queries
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
      queries
        .getMutationCache()
        .getAll()
        .map((m) => [m.state.data, m.state.variables]),
    ]);
    expect(cached).not.toContain(token);
    const trail = await audited("token.create", made?.id ?? "");
    expect(trail.length).toBe(1);
    expect(JSON.stringify(trail)).not.toContain(token);

    // done: gone from the screen, and a new look at the page does not bring it back
    await user.click(within(fresh).getByRole("button", { name: "I have copied it" }));
    expect(screen.queryByRole("region", { name: "New token" })).toBeNull();
    expect(onPage(token)).toBe(false);
    cleanup();
    mount(s.client);
    await tokenTable();
    expect(onPage(token)).toBe(false);
  });

  test("while a token is on show the form is away, so a second one cannot take its place", async () => {
    const s = await sceneOn(backend);
    mount(s.client);
    const user = userEvent.setup();
    const formOnPage = () => document.querySelector('form[aria-label="Create a token"]') !== null;
    let form = await fill(user, "one", "variable.read");
    await user.click(within(form).getByRole("button", { name: "Create token" }));
    const first = (await screen.findByLabelText("Token", undefined, {
      timeout: 5000,
    })) as HTMLInputElement;
    const one = first.value;
    expect(formOnPage()).toBe(false);
    expect(onPage(one)).toBe(true);

    // once it is let go, the form is back and empty, and the next token is a token of its own
    await user.click(screen.getByRole("button", { name: "I have copied it" }));
    expect(formOnPage()).toBe(true);
    form = screen.getByRole("form", { name: "Create a token" });
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("");
    expect((within(form).getByLabelText("Scopes") as HTMLInputElement).value).toBe("");
    form = await fill(user, "two", "variable.read");
    await user.click(within(form).getByRole("button", { name: "Create token" }));
    await waitFor(
      () =>
        expect(
          (document.querySelector('input[aria-label="Token"]') as HTMLInputElement | null)?.value
            ? (document.querySelector('input[aria-label="Token"]') as HTMLInputElement).value !==
                one
            : false,
        ).toBe(true),
      { timeout: 5000 },
    );
    expect((await tokensOf(s)).map((t) => t.name).sort()).toEqual(["one", "two"]);
    expect(onPage(one)).toBe(false);
  });

  test("copies the token when the browser allows it, and says so when it does not", async () => {
    const s = await sceneOn(backend);
    mount(s.client);
    const user = userEvent.setup();
    const form = await fill(user, "ci", "variable.read");
    await user.click(within(form).getByRole("button", { name: "Create token" }));
    const fresh = await screen.findByRole("region", { name: "New token" }, { timeout: 5000 });
    const token = (within(fresh).getByLabelText("Token") as HTMLInputElement).value;
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const written: string[] = [];
    const stub = (writeText: (text: string) => Promise<void>) =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
    try {
      stub(async (text) => {
        written.push(text);
      });
      await user.click(within(fresh).getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(statusText()).toBe("Copied."));
      expect(written).toEqual([token]);

      stub(async () => {
        throw new Error("no permission");
      });
      await user.click(within(fresh).getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(alertText() === undefined).toBe(false));
      expect(alertText()).toContain("select the token and copy it");
      // it is still there to be copied by hand
      expect((within(fresh).getByLabelText("Token") as HTMLInputElement).value).toBe(token);
    } finally {
      if (original) Object.defineProperty(navigator, "clipboard", original);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  test("a scope that is not one is refused, with nothing shown and nothing made", async () => {
    const s = await sceneOn(backend);
    mount(s.client);
    const user = userEvent.setup();
    const form = await fill(user, "bad", "not.a.scope");
    await user.click(within(form).getByRole("button", { name: "Create token" }));
    await waitFor(() => expect(alertText() !== undefined).toBe(true), { timeout: 5000 });
    expect(screen.queryByRole("region", { name: "New token" })).toBeNull();
    expect(await tokensOf(s)).toEqual([]);
    expect(screen.getByText("You have no tokens.")).toBeDefined();
  });

  test("revokes one only after a confirm, and the list says it is revoked", async () => {
    const s = await sceneOn(backend);
    const made = must(
      await s.client.tokens.post({ name: "old", scopes: ["variable.read"], expiresInDays: 7 }),
    );
    mount(s.client);
    const user = userEvent.setup();
    const row = () => rowOf(screen.getByRole("table", { name: "Your API tokens" }), "old");
    await tokenTable();
    await user.click(within(row()).getByRole("button", { name: "Revoke…" }));
    await user.click(within(row()).getByRole("button", { name: "Keep" }));
    expect(within(row()).getByRole("button", { name: "Revoke…" })).toBeDefined();
    expect((await tokensOf(s))[0]?.revokedAt).toBeNull();

    await user.click(within(row()).getByRole("button", { name: "Revoke…" }));
    await user.click(within(row()).getByRole("button", { name: "Revoke old" }));
    await waitFor(() => expect(row().textContent?.includes("Revoked")).toBe(true), {
      timeout: 5000,
    });
    expect(within(row()).queryByRole("button")).toBeNull();
    expect((await tokensOf(s))[0]?.revokedAt).not.toBeNull();
    expect((await audited("token.revoke", made.id)).length).toBe(1);
  });

  test("an expired token is listed as expired, with nothing to revoke", async () => {
    const s = await sceneOn(backend);
    const made = must(
      await s.client.tokens.post({ name: "stale", scopes: ["variable.read"], expiresInDays: 1 }),
    );
    await backend.t.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(apiTokens.id, made.id));
    mount(s.client);
    const row = rowOf(await tokenTable(), "stale");
    expect(row.textContent).toContain("Expired");
    expect(within(row).queryByRole("button")).toBeNull();
  });

  test("lists only the tokens of the person looking", async () => {
    const s = await sceneOn(backend);
    const other = await backend.signIn("someone else");
    must(
      await other.client.tokens.post({
        name: "theirs",
        scopes: ["variable.read"],
        expiresInDays: 7,
      }),
    );
    must(await s.client.tokens.post({ name: "mine", scopes: ["variable.read"], expiresInDays: 7 }));
    mount(s.client);
    const t = await tokenTable();
    expect(
      within(t)
        .getAllByRole("rowheader")
        .map((h) => h.textContent),
    ).toEqual(["mine"]);
  });
});

afterEach(() => cleanup());
