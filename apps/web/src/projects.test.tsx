import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { auditEvents, createProject } from "@orch/db";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eq } from "drizzle-orm";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/projects";
  try {
    localStorage.clear();
  } catch {
    // the page copes without it
  }
});

const BAD_TOKEN = "glpat-wrong-token-0123456789";

/** An organization with an admin (or a member), and a mock GitLab of its own. */
async function scene(role: "admin" | "member" = "admin") {
  const org = await backend.organization();
  const mock = backend.gitlab();
  const { client, user, cookie } = await backend.signIn(`${role} of ${org.slug}`, {
    orgRoles: { [org.id]: role },
    projectRoles: {},
  });
  const connect = () =>
    client.organizations({ orgId: org.id }).connections.post({
      type: "gitlab",
      name: "Mock GitLab",
      baseUrl: mock.url,
      token: mock.token,
    });
  return { org, mock, client, user, cookie, connect };
}

const connectionsOf = async (s: Awaited<ReturnType<typeof scene>>) =>
  (await s.client.organizations({ orgId: s.org.id }).connections.get({ query: { limit: 100 } }))
    .data?.items ?? [];

async function fillConnection(
  user: ReturnType<typeof userEvent.setup>,
  url: string,
  token: string,
) {
  await user.clear(await screen.findByLabelText("GitLab address"));
  await user.type(screen.getByLabelText("GitLab address"), url);
  await user.type(screen.getByLabelText("Access token"), token);
  await user.click(screen.getByRole("button", { name: "Connect" }));
}

const box = async (path: string) => screen.findByRole("checkbox", { name: new RegExp(`^${path}`) });

describe("no organization", () => {
  test("says so, on the home page and the projects page, instead of an empty screen", async () => {
    const { client } = await backend.signIn("Loner");
    mount(client);
    expect((await screen.findByText(/not in an organization/)).textContent).toContain(
      "platform admin",
    );
    expect(screen.queryByRole("form", { name: "Connect GitLab" })).toBeNull();
  });
});

describe("connecting GitLab", () => {
  test("the first run shows the checklist with nothing done, and the one organization by name", async () => {
    const s = await scene();
    window.location.hash = "";
    mount(s.client);
    const list = await screen.findByRole("region", { name: "Getting started" });
    const steps = await within(list).findAllByRole("listitem");
    expect(steps.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Connect a forge (to do)"),
      expect.stringContaining("Import your projects (to do)"),
    ]);
    expect(within(list).getByRole("link", { name: "Connect a forge" }).getAttribute("href")).toBe(
      "#/projects",
    );
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.queryByLabelText("Organization")).toBeNull();
  });

  test("a wrong token says why, keeps nothing, and the token is not on the page", async () => {
    const s = await scene();
    mount(s.client);
    await fillConnection(userEvent.setup(), s.mock.url, BAD_TOKEN);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("GitLab rejected the token");
    expect(document.body.textContent).not.toContain(BAD_TOKEN);
    expect(screen.getByLabelText("Access token").getAttribute("type")).toBe("password");
    expect(await connectionsOf(s)).toHaveLength(0);
    expect(screen.queryByText("Import from GitLab")).toBeNull();
  });

  test("a good token connects, lists what GitLab shows and forgets the token", async () => {
    const s = await scene();
    s.mock.addProject({ path: "acme/api", files: { "bun.lock": "" } });
    const { queries } = mount(s.client);
    await fillConnection(userEvent.setup(), s.mock.url, s.mock.token);
    expect(await screen.findByRole("heading", { name: "Import from GitLab" })).toBeTruthy();
    expect(await box("acme/api")).toBeTruthy();
    expect(await connectionsOf(s)).toHaveLength(1);
    expect(document.body.textContent).not.toContain(s.mock.token);
    // the token lives in the mutation function, so the mutation itself must not be kept
    await waitFor(() => expect(queries.getMutationCache().getAll()).toHaveLength(0));
    expect((await connectionsOf(s))[0]?.name).toBe("GitLab");
    const audit = await backend.t.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "connection.create"));
    expect(JSON.stringify(audit)).not.toContain(s.mock.token);
  });

  test("a token GitLab shows nothing to says so", async () => {
    const s = await scene();
    await s.connect();
    mount(s.client);
    expect(
      (await screen.findByText(/GitLab shows no projects for this token/)).textContent,
    ).toContain("member");
    expect(screen.getByRole("button", { name: "Import 0 selected" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("a search with no match says so; a match narrows the list", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/api", files: {} });
    s.mock.addProject({ path: "acme/web", files: {} });
    mount(s.client);
    const user = userEvent.setup();
    await box("acme/api");
    await user.type(screen.getByRole("searchbox"), "zzz{Enter}");
    expect(await screen.findByText(/no projects matching “zzz”/)).toBeTruthy();
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "  web {Enter}");
    expect(await box("acme/web")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /acme\/api/ })).toBeNull();
  });

  test("more than a page of projects is shown a page at a time", async () => {
    const s = await scene();
    await s.connect();
    for (let n = 1; n <= 51; n++) s.mock.addProject({ path: `acme/p${n}`, files: {} });
    mount(s.client);
    await screen.findAllByRole("checkbox");
    expect(screen.getAllByRole("checkbox")).toHaveLength(50);
    // in a row, so it keeps its own width instead of stretching across the grid like a primary action
    expect(screen.getByRole("button", { name: "Show more" }).parentElement?.className).toBe("row");
    await userEvent.setup().click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(51));
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  test("GitLab failing is an error with a way to try again", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/api", files: {} });
    s.mock.inject({ path: "/api/v4/projects", status: 401, times: 1 });
    mount(s.client);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/GitLab/);
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await box("acme/api")).toBeTruthy();
  });
});

describe("importing", () => {
  test("creates the picked projects with what was detected, then updates them", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/api", files: { "bun.lock": "", "package.json": "{}" } });
    s.mock.addProject({ path: "acme/img", files: { Dockerfile: "FROM scratch" } });
    s.mock.addProject({ path: "acme/other", files: {} });
    mount(s.client);
    const user = userEvent.setup();
    await user.click(await box("acme/api"));
    await user.click(await box("acme/img"));
    await user.click(screen.getByRole("button", { name: "Import 2 selected" }));

    const results = await screen.findByRole("region", { name: "Import results" });
    const [api, img] = within(results).getAllByRole("listitem");
    expect(api?.textContent).toContain("acme/api: created");
    expect(api?.textContent).toContain("bun");
    expect(img?.textContent).toContain("acme/img: created");
    expect(img?.textContent).toContain("docker");
    // the projects table and the "imported" badges follow
    const table = await screen.findByRole("table", { name: "Imported projects" });
    expect(within(table).getByRole("rowheader", { name: "acme/api" })).toBeTruthy();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: /^acme\/api imported/ })).toBeTruthy(),
    );
    // nothing is left picked
    expect(screen.getByRole("button", { name: "Import 0 selected" })).toBeTruthy();

    await user.click(screen.getByRole("checkbox", { name: /^acme\/api imported/ }));
    await user.click(screen.getByRole("button", { name: "Import 1 selected" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: "Import results" })).getByRole("listitem")
          .textContent,
      ).toContain("acme/api: updated"),
    );
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  test("a repository with nothing to detect says so", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/docs", files: { "README.md": "" } });
    mount(s.client);
    const user = userEvent.setup();
    await user.click(await box("acme/docs"));
    await user.click(screen.getByRole("button", { name: "Import 1 selected" }));
    expect((await screen.findByRole("region", { name: "Import results" })).textContent).toContain(
      "none detected",
    );
  });

  test("one project failing does not stop the rest, and only it stays picked", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/ok", files: { "bun.lock": "" } });
    const clash = s.mock.addProject({ path: "acme/clash", files: {} });
    await createProject(backend.t.db, { organizationId: s.org.id, name: clash.path });
    mount(s.client);
    const user = userEvent.setup();
    await user.click(await box("acme/ok"));
    await user.click(await box("acme/clash"));
    await user.click(screen.getByRole("button", { name: "Import 2 selected" }));

    const results = await screen.findByRole("region", { name: "Import results" });
    const [first, second] = within(results).getAllByRole("listitem");
    expect(first?.textContent).toContain("acme/ok: created");
    expect(second?.textContent).toContain("acme/clash: not imported");
    expect(second?.className).toBe("error");
    expect(second?.textContent).toMatch(/already|taken|name/i);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Import 1 selected" })).toBeTruthy(),
    );
    expect(
      (screen.getByRole("checkbox", { name: /^acme\/clash/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect((screen.getByRole("checkbox", { name: /^acme\/ok/ }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  test("a project GitLab no longer lets the token see fails alone, with GitLab's word for it", async () => {
    const s = await scene();
    await s.connect();
    const gone = s.mock.addProject({ path: "acme/gone", files: {} });
    s.mock.addProject({ path: "acme/here", files: {} });
    mount(s.client);
    const user = userEvent.setup();
    await user.click(await box("acme/gone"));
    await user.click(await box("acme/here"));
    s.mock.inject({ path: `/api/v4/projects/${gone.id}`, status: 403, times: 5 });
    await user.click(screen.getByRole("button", { name: "Import 2 selected" }));
    const results = await screen.findByRole("region", { name: "Import results" });
    const [first, second] = within(results).getAllByRole("listitem");
    expect(first?.textContent).toContain("acme/gone: not imported");
    expect(second?.textContent).toContain("acme/here: created");
  });

  test("no more than 25 can be picked for one import", async () => {
    const s = await scene();
    await s.connect();
    for (let n = 1; n <= 26; n++)
      s.mock.addProject({ path: `acme/p${String(n).padStart(2, "0")}`, files: {} });
    mount(s.client);
    const user = userEvent.setup();
    await screen.findAllByRole("checkbox");
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(26);
    for (const b of boxes.slice(0, 25)) await user.click(b);
    expect(screen.getByRole("button", { name: "Import 25 selected" })).toBeTruthy();
    expect(boxes[25]?.disabled).toBe(true);
    expect(screen.getByText(/the most one import takes \(25\)/)).toBeTruthy();
    await user.click(boxes[0] as HTMLInputElement);
    expect(boxes[25]?.disabled).toBe(false);
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByRole("button", { name: "Import 0 selected" })).toBeTruthy();
    expect(boxes.filter((b) => b.checked)).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Clear selection" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
});

describe("what the screen shows of a project", () => {
  test("a type found below the root is marked likely, with the paths that suggested it", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/infra", files: { "bun.lock": "", "infra/main.tf": "" } });
    mount(s.client);
    const user = userEvent.setup();
    await user.click(await box("acme/infra"));
    await user.click(screen.getByRole("button", { name: "Import 1 selected" }));
    const item = within(await screen.findByRole("region", { name: "Import results" })).getByRole(
      "listitem",
    );
    expect(item.textContent).toContain("terraform (likely)");
    expect(item.textContent).toMatch(/bun(?! \(likely\))/);
    expect(screen.getAllByTitle("infra/main.tf").length).toBeGreaterThan(0);
  });

  test("archived and empty repositories are marked in the list", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/old", archived: true, files: {} });
    s.mock.addProject({ path: "acme/blank", defaultBranch: null, files: {} });
    s.mock.addProject({ path: "acme/live", files: {} });
    mount(s.client);
    expect((await box("acme/old")).closest("label")?.textContent).toContain("archived");
    expect((await box("acme/blank")).closest("label")?.textContent).toContain("empty");
    const live = (await box("acme/live")).closest("label")?.textContent ?? "";
    expect(live).not.toMatch(/archived|empty|imported/);
  });

  test("a large repository says its types may be incomplete", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/big", files: { "bun.lock": "" } });
    const client = clientVia(backend.api, s.cookie, async (request, send) => {
      const res = await send();
      if (!pathOf(request).endsWith("/imports")) return res;
      const body = await res.json();
      return Response.json({
        results: body.results.map((r: object) => ({ ...r, truncated: true })),
      });
    });
    mount(client);
    const user = userEvent.setup();
    await user.click(await box("acme/big"));
    await user.click(screen.getByRole("button", { name: "Import 1 selected" }));
    expect((await screen.findByRole("region", { name: "Import results" })).textContent).toContain(
      "types may be incomplete",
    );
  });
});

describe("when the server fails", () => {
  test("an import that fails as a whole is an error, and the picks are kept to try again", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/api", files: {} });
    const client = clientVia(backend.api, s.cookie, (request, send) =>
      Promise.resolve(pathOf(request).endsWith("/imports") ? down("Imports are down.") : send()),
    );
    mount(client);
    const user = userEvent.setup();
    await user.click(await box("acme/api"));
    await user.click(screen.getByRole("button", { name: "Import 1 selected" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Imports are down.");
    expect((screen.getByRole("checkbox", { name: /^acme\/api/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.queryByRole("region", { name: "Import results" })).toBeNull();
  });

  const connectionsDown = async () => {
    const s = await scene();
    await s.connect();
    return clientVia(backend.api, s.cookie, (request, send) =>
      Promise.resolve(
        request.method === "GET" && pathOf(request).endsWith("/connections")
          ? down("Connections are down.")
          : send(),
      ),
    );
  };

  test("connections that cannot be read are an error on Projects, with a way to try again", async () => {
    mount(await connectionsDown());
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Connections are down.");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Connect GitLab" })).toBeNull();
  });

  test("and Home shows no half-checklist", async () => {
    window.location.hash = "";
    const { settled } = mount(await connectionsDown());
    await screen.findByRole("heading", { name: "Welcome" });
    await settled();
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("when the organizations cannot be listed", () => {
  test("it is an error with a way to try again, not an empty screen", async () => {
    const s = await scene();
    let failing = true;
    const client = clientVia(backend.api, s.cookie, (request, send) =>
      Promise.resolve(
        failing && pathOf(request) === "/organizations" ? down("Organizations are down.") : send(),
      ),
    );
    mount(client);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Organizations are down.");
    expect(screen.queryByText(/not in an organization/)).toBeNull();
    failing = false;
    await userEvent.setup().click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Connect GitLab" })).toBeTruthy();
  });
});

describe("more than one connection", () => {
  test("another can be added, is then the one browsed, and the first can be chosen again", async () => {
    const s = await scene();
    const second = backend.gitlab();
    s.mock.addProject({ path: "one/first", files: {} });
    second.addProject({ path: "two/second", files: {} });
    await s.connect();
    mount(s.client);
    const user = userEvent.setup();
    await box("one/first");

    await user.click(screen.getByRole("button", { name: "Add a connection" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await box("one/first")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add a connection" }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Second GitLab");
    await fillConnection(user, second.url, second.token);
    expect(await box("two/second")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /one\/first/ })).toBeNull();
    const names = within(screen.getByLabelText("Connection")).getAllByRole("option");
    expect(names.map((o) => o.textContent).sort()).toEqual(["Mock GitLab", "Second GitLab"]);

    await user.click(await box("two/second"));
    expect(screen.getByRole("button", { name: "Import 1 selected" })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Connection"), "Mock GitLab");
    expect(screen.getByRole("button", { name: "Import 0 selected" })).toBeTruthy();
    expect(await box("one/first")).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: /two\/second/ })).toBeNull();
  });
});

describe("the checklist, while it cannot know", () => {
  const held = async (hold: "connections" | "projects", fail: boolean) => {
    const s = await scene();
    await s.connect();
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/there" });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = clientVia(backend.api, s.cookie, async (request, send) => {
      if (request.method !== "GET" || !pathOf(request).endsWith(`/${hold}`)) return send();
      await gate;
      return fail ? down("Down.") : send();
    });
    return { client, release, orgId: s.org.id };
  };

  test("is not shown from one answer: set up is not said before the connections arrive", async () => {
    window.location.hash = "";
    const { client, release } = await held("connections", false);
    const { settled } = mount(client);
    await screen.findByRole("heading", { name: "Welcome" });
    // shortcut: the organizations answer takes up to ~1.5 s through clientVia here (cause not found, the server is fast on its own); give it room (the test limit is 15 s so that this wait can use its 5 s under load)
    await waitFor(() => expect(screen.queryByText(/Loading organizations/)).toBeNull(), {
      timeout: 5000,
    });
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    release();
    const list = await screen.findByRole("region", { name: "Getting started" });
    expect(within(list).getByRole("heading", { name: "You are set up" })).toBeTruthy();
    await settled();
  }, 15_000);

  test("is not shown when the projects cannot be read", async () => {
    window.location.hash = "";
    const { client, release, orgId } = await held("projects", true);
    const { settled, queries } = mount(client);
    await screen.findByRole("heading", { name: "Welcome" });
    // the connections are in, the projects are not: still nothing to say
    await waitFor(() => expect(queries.getQueryData(["connections", orgId])).toBeDefined(), {
      timeout: 5000,
    });
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    release();
    await settled();
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
  }, 15_000);
});

describe("the first run, finished", () => {
  test("the checklist says the user is set up once both steps are done", async () => {
    const s = await scene();
    await s.connect();
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/done" });
    window.location.hash = "";
    mount(s.client);
    const list = await screen.findByRole("region", { name: "Getting started" });
    expect(within(list).getByRole("heading", { name: "You are set up" })).toBeTruthy();
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining("Connect a forge (done)"),
      expect.stringContaining("Import your projects (done)"),
    ]);
  });
});

describe("roles and organizations", () => {
  test("a member sees the projects, is told importing needs an admin, and has no connect step", async () => {
    const s = await scene("member");
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/seen" });
    const { settled } = mount(s.client);
    expect(await screen.findByText("Importing projects needs an organization admin.")).toBeTruthy();
    expect(await screen.findByRole("rowheader", { name: "acme/seen" })).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Connect GitLab" })).toBeNull();

    window.location.hash = "";
    // the hash changes after the render, so wait for the home page itself
    await screen.findByRole("heading", { name: "Welcome" });
    await settled();
    const list = screen.getByRole("region", { name: "Getting started" });
    expect(within(list).queryByRole("link", { name: "Connect a forge" })).toBeNull();
    expect(within(list).getByRole("link", { name: "Import your projects" })).toBeTruthy();
  });

  test("with several organizations the user picks one, and it is remembered", async () => {
    const [a, b] = [await backend.organization("Alpha"), await backend.organization("Beta")];
    const { client } = await backend.signIn("Both", {
      orgRoles: { [a.id]: "member", [b.id]: "member" },
      projectRoles: {},
    });
    await createProject(backend.t.db, { organizationId: a.id, name: "alpha/one" });
    await createProject(backend.t.db, { organizationId: b.id, name: "beta/one" });
    const view = mount(client);
    const first = await screen.findByLabelText("Organization");
    const names = within(first)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(names).toEqual(["Alpha", "Beta"]);
    expect(await screen.findByRole("rowheader", { name: "alpha/one" })).toBeTruthy();

    await userEvent.setup().selectOptions(first, "Beta");
    expect(await screen.findByRole("rowheader", { name: "beta/one" })).toBeTruthy();
    expect(screen.queryByRole("rowheader", { name: "alpha/one" })).toBeNull();

    view.unmount();
    mount(client);
    expect(await screen.findByRole("rowheader", { name: "beta/one" })).toBeTruthy();
  });
});

describe("the remembered organization", () => {
  const both = async () => {
    const [a, b] = [await backend.organization("Alpha"), await backend.organization("Beta")];
    const roles = {
      orgRoles: { [a.id]: "member" as const, [b.id]: "member" as const },
      projectRoles: {},
    };
    const { client, user } = await backend.signIn("Either", roles);
    await createProject(backend.t.db, { organizationId: a.id, name: "alpha/one" });
    await createProject(backend.t.db, { organizationId: b.id, name: "beta/one" });
    return { client, user, other: await backend.signIn("Other", roles) };
  };

  test("an organization that is gone is forgotten: the first one is shown", async () => {
    const { client, user } = await both();
    localStorage.setItem(`orch.org.${user.id}`, "00000000-0000-4000-8000-000000000000");
    mount(client);
    expect(await screen.findByRole("rowheader", { name: "alpha/one" })).toBeTruthy();
    expect((screen.getByLabelText("Organization") as HTMLSelectElement).value).not.toBe("");
  });

  test("another user of the same browser does not inherit the choice", async () => {
    const { client, other } = await both();
    const first = mount(client);
    await userEvent.setup().selectOptions(await screen.findByLabelText("Organization"), "Beta");
    expect(await screen.findByRole("rowheader", { name: "beta/one" })).toBeTruthy();
    first.unmount();
    mount(other.client);
    expect(await screen.findByRole("rowheader", { name: "alpha/one" })).toBeTruthy();
    expect(
      (screen.getByLabelText("Organization") as HTMLSelectElement).selectedOptions[0]?.textContent,
    ).toBe("Alpha");
  });

  test("browser storage that throws does not stop the page or the choice", async () => {
    const { client } = await both();
    const kept = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    try {
      mount(client);
      expect(await screen.findByRole("rowheader", { name: "alpha/one" })).toBeTruthy();
      await userEvent.setup().selectOptions(screen.getByLabelText("Organization"), "Beta");
      expect(await screen.findByRole("rowheader", { name: "beta/one" })).toBeTruthy();
    } finally {
      if (kept) Object.defineProperty(globalThis, "localStorage", kept);
    }
  });
});

describe("how the screen is laid out", () => {
  test("the imported projects and the import flow are each a named card", async () => {
    const s = await scene();
    await s.connect();
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/kept" });
    mount(s.client);
    const projects = await screen.findByRole("region", { name: "Imported projects" });
    expect(await within(projects).findByRole("rowheader", { name: "acme/kept" })).toBeTruthy();
    const flow = await screen.findByRole("region", { name: "Import from GitLab" });
    expect(within(flow).getByRole("button", { name: "Import 0 selected" })).toBeTruthy();
  });

  test("with no connection, the form to add one sits in a card", async () => {
    const s = await scene();
    mount(s.client);
    const form = await screen.findByRole("form", { name: "Connect GitLab" });
    expect(form.closest(".card")).not.toBeNull();
  });

  test("imported and archived are badges, each with words and a shape that is not read out", async () => {
    const s = await scene();
    await s.connect();
    s.mock.addProject({ path: "acme/old", archived: true, files: {} });
    s.mock.addProject({ path: "acme/api", files: { "bun.lock": "" } });
    mount(s.client);
    const user = userEvent.setup();
    await user.click(await box("acme/api"));
    await user.click(screen.getByRole("button", { name: "Import 1 selected" }));
    const imported = await screen.findByRole("checkbox", { name: /^acme\/api imported/ });
    const badge = (label: HTMLElement | null, words: string) =>
      Array.from(label?.querySelectorAll(".st") ?? []).find((b) => b.textContent === words);
    const done = badge(imported.closest("label"), "imported");
    expect(done?.className).toBe("st st-ok");
    expect(done?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const old = badge((await box("acme/old")).closest("label"), "archived");
    expect(old?.className).toBe("st st-quiet");
  });
});
