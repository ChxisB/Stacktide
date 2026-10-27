import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { envKeyProvider } from "@orch/crypto";
import { createConnection, createProject } from "@orch/db";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { addressOf, hostOf, pathOn } from "./projects";
import { type Backend, mount, startBackend } from "./testing";
import { must } from "./variables.fixture";

// FRG-24: the screens take either forge, and say what a project's forge cannot do instead of offering it.

const TOKEN = "ghp_not-a-real-token-1234";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/projects";
});
afterEach(cleanup);

/** An organization with an admin, and a mock GitHub of its own (and a mock GitLab when asked for). */
async function scene() {
  const org = await backend.organization();
  const hub = backend.github(TOKEN);
  const lab = backend.gitlab();
  const admin = await backend.signIn(`admin of ${org.slug}`, {
    orgRoles: { [org.id]: "admin" },
    projectRoles: {},
  });
  const scope = admin.client.organizations({ orgId: org.id });
  const github = async () =>
    must(
      await scope.connections.post({ type: "github", name: "hub", baseUrl: hub.url, token: TOKEN }),
    );
  const gitlab = async () =>
    must(
      await scope.connections.post({
        type: "gitlab",
        name: "lab",
        baseUrl: lab.url,
        token: lab.token,
      }),
    );
  return { org, hub, lab, admin, scope, github, gitlab };
}

describe("connecting GitHub", () => {
  test("the form offers GitHub, connects with a token that GitHub accepts and forgets the token", async () => {
    const s = await scene();
    mount(s.admin.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add a connection" }));
    // GitLab first, as it was
    expect(await screen.findByRole("form", { name: "Connect GitLab" })).toBeTruthy();
    await user.selectOptions(screen.getByLabelText("Forge"), "GitHub");
    expect(screen.getByRole("form", { name: "Connect GitHub" })).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("GitHub");
    expect((screen.getByLabelText("GitHub address") as HTMLInputElement).value).toBe(
      "https://github.com",
    );
    await user.clear(screen.getByLabelText("GitHub address"));
    await user.type(screen.getByLabelText("GitHub address"), s.hub.url);
    await user.type(screen.getByLabelText("Access token"), TOKEN);
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("region", { name: "Import from GitHub" });
    const listed = must(await s.scope.connections.get({ query: { limit: 100 } })).items;
    expect(listed.map((c) => [c.type, c.name])).toEqual([["github", "GitHub"]]);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  test("choosing the forge changes the defaults it was given, not what was typed", async () => {
    const s = await scene();
    mount(s.admin.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add a connection" }));
    await user.clear(await screen.findByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "our forge");
    await user.selectOptions(screen.getByLabelText("Forge"), "GitHub");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("our forge");
    expect((screen.getByLabelText("GitHub address") as HTMLInputElement).value).toBe(
      "https://github.com",
    );
    await user.selectOptions(screen.getByLabelText("Forge"), "GitLab");
    expect((screen.getByLabelText("GitLab address") as HTMLInputElement).value).toBe(
      "https://gitlab.com",
    );
  });

  test("a token GitHub refuses says so and stores nothing", async () => {
    const s = await scene();
    mount(s.admin.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add a connection" }));
    await user.selectOptions(await screen.findByLabelText("Forge"), "GitHub");
    await user.clear(screen.getByLabelText("GitHub address"));
    await user.type(screen.getByLabelText("GitHub address"), s.hub.url);
    await user.type(screen.getByLabelText("Access token"), "ghp_the-wrong-token-9999");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByRole("alert");
    expect(must(await s.scope.connections.get({ query: { limit: 100 } })).items).toEqual([]);
    // the field still holds what was typed; nothing the page says does
    expect(document.body.textContent).not.toContain("ghp_the-wrong-token-9999");
  });
});

describe("onboarding with a repository address", () => {
  test("an address on GitHub picks the GitHub connection and ticks the repository, which is then imported", async () => {
    const s = await scene();
    await s.gitlab();
    await s.github();
    s.hub.addRepo("acme", "web", { files: { "bun.lock": "" } });
    s.hub.addRepo("acme", "web-docs", { files: {} });
    mount(s.admin.client);
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Repository address" });
    await user.type(within(form).getByLabelText("Repository address"), `${s.hub.url}/acme/web.git`);
    await user.click(within(form).getByRole("button", { name: "Find" }));
    // the card moved to the connection the address belongs to, and the exact repository is ticked, not its neighbour
    await screen.findByRole("region", { name: "Import from GitHub" });
    const box = (await screen.findByRole("checkbox", { name: /^acme\/web$/ })) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    expect(
      (screen.getByRole("checkbox", { name: /^acme\/web-docs/ }) as HTMLInputElement).checked,
    ).toBe(false);
    await user.click(screen.getByRole("button", { name: "Import 1 selected" }));
    const results = await screen.findByRole("region", { name: "Import results" });
    expect(results.textContent).toContain("acme/web: created");
    // the imported list names the forge
    const table = await screen.findByRole("table", { name: "Imported projects" });
    const row = within(table).getByRole("rowheader", { name: "acme/web" }).closest("tr");
    expect(row?.textContent).toContain("GitHub");
  });

  test("the address searches for the repository's name, ticks it whatever its case, and an untick sticks", async () => {
    const s = await scene();
    await s.github();
    s.hub.addRepo("Acme", "Web", { files: {} });
    s.hub.addRepo("acme", "web-docs", { files: {} });
    s.hub.addRepo("acme", "api", { files: {} });
    mount(s.admin.client);
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Repository address" });
    await user.type(within(form).getByLabelText("Repository address"), `${s.hub.url}/acme/web`);
    await user.click(within(form).getByRole("button", { name: "Find" }));
    const box = (await screen.findByRole("checkbox", { name: /^Acme\/Web$/ })) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    // only what the name matches was asked for
    expect(screen.queryByRole("checkbox", { name: /^acme\/api/ })).toBeNull();
    // unticked, it stays so when the list comes round again
    await user.click(box);
    const search = screen.getByRole("form", { name: "Search GitHub repositories" });
    const searchFor = async (text: string) => {
      await user.clear(within(search).getByLabelText("Search by name"));
      await user.type(within(search).getByLabelText("Search by name"), text);
      await user.click(within(search).getByRole("button", { name: "Search" }));
    };
    await searchFor("docs");
    await screen.findByRole("checkbox", { name: /^acme\/web-docs/ });
    await searchFor("web");
    const again = (await screen.findByRole("checkbox", {
      name: /^Acme\/Web$/,
    })) as HTMLInputElement;
    expect(again.checked).toBe(false);
  });

  test("an address on GitLab picks the GitLab connection", async () => {
    const s = await scene();
    await s.github();
    await s.gitlab();
    s.lab.addProject({ path: "grp/app", files: {} });
    mount(s.admin.client);
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Repository address" });
    await user.type(within(form).getByLabelText("Repository address"), `${s.lab.url}/grp/app`);
    await user.click(within(form).getByRole("button", { name: "Find" }));
    await screen.findByRole("region", { name: "Import from GitLab" });
    const box = (await screen.findByRole("checkbox", { name: /^grp\/app/ })) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
  });

  test("an address no connection reaches, or that is no address, is said so and changes nothing", async () => {
    const s = await scene();
    await s.github();
    mount(s.admin.client);
    const user = userEvent.setup();
    const form = await screen.findByRole("form", { name: "Repository address" });
    const box = within(form).getByLabelText("Repository address");
    await user.type(box, "https://git.example.org/team/app");
    await user.click(within(form).getByRole("button", { name: "Find" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("git.example.org");
    await user.clear(box);
    await user.type(box, "not an address");
    await user.click(within(form).getByRole("button", { name: "Find" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("repository address");
    // still on the connection it was on
    expect(screen.getByRole("region", { name: "Import from GitHub" })).toBeTruthy();
  });
});

describe("reading a repository address", () => {
  test("the host and path of a web address, whatever dresses it", () => {
    expect(addressOf("https://github.com/acme/web")).toEqual({
      host: "github.com",
      path: "acme/web",
    });
    expect(addressOf("  http://GitHub.com/acme/web.git/ ")).toEqual({
      host: "github.com",
      path: "acme/web",
    });
    expect(addressOf("https://gitlab.example.com/grp/sub/app")).toEqual({
      host: "gitlab.example.com",
      path: "grp/sub/app",
    });
    // GitHub's API host and its web host are one connection
    expect(addressOf("https://api.github.com/repos")?.host).toBe("github.com");
    for (const no of [
      "not an address",
      "git@github.com:acme/web.git",
      "ftp://h/a/b",
      "https://h/",
    ]) {
      expect([no, addressOf(no)]).toEqual([no, undefined]);
    }
  });

  test("a connection's host is the one its address is made with, API host or web host", () => {
    expect(hostOf({ baseUrl: "https://api.github.com" })).toBe("github.com");
    expect(hostOf({ baseUrl: "https://github.com/" })).toBe("github.com");
    expect(hostOf({ baseUrl: "http://127.0.0.1:8080" })).toBe("127.0.0.1:8080");
    expect(hostOf({})).toBeUndefined();
  });

  test("the repository is what the forge calls one: owner/name on GitHub, up to /-/ on GitLab", () => {
    expect(pathOn("github", "acme/web/tree/main")).toBe("acme/web");
    expect(pathOn("gitlab", "grp/sub/app/-/tree/main")).toBe("grp/sub/app");
    expect(pathOn("gitlab", "grp/app")).toBe("grp/app");
  });
});

/** A project of each forge in one organization, as an import would leave them. */
async function twoProjects(s: Awaited<ReturnType<typeof scene>>) {
  const hubConnection = await s.github();
  const labConnection = await s.gitlab();
  const repo = s.hub.addRepo("acme", "svc", { files: {} });
  const gl = s.lab.addProject({ path: "grp/app", files: {} });
  await createProject(backend.t.db, {
    organizationId: s.org.id,
    name: "acme/svc",
    gitlabProjectId: repo.id,
    connectionId: hubConnection.id,
  });
  await createProject(backend.t.db, {
    organizationId: s.org.id,
    name: "grp/app",
    gitlabProjectId: gl.id,
    connectionId: labConnection.id,
  });
}

describe("what a project's forge cannot do", () => {
  test("deployments: GitHub's card is read and refreshed as GitLab's is, and never names the other forge", async () => {
    const s = await scene();
    await twoProjects(s);
    window.location.hash = "#/status";
    mount(s.admin.client);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText("Project"), "acme/svc");
    const card = await screen.findByRole("region", { name: "Deployments" });
    expect(card.textContent).toContain("What GitHub says is deployed");
    expect(card.textContent).not.toContain("GitLab");
    await within(card).findByRole("button", { name: "Refresh" });
    await user.selectOptions(screen.getByLabelText("Project"), "grp/app");
    const lab = await screen.findByRole("region", { name: "Deployments" });
    expect(lab.textContent).toContain("What GitLab says is deployed");
    await within(lab).findByRole("button", { name: "Refresh" });
  });

  test("runners: GitHub's pool section says why health cannot be checked, GitLab's keeps its button", async () => {
    const s = await scene();
    await twoProjects(s);
    must(await s.scope.pools.post({ name: "own", tags: ["own"] }));
    window.location.hash = "#/settings";
    mount(s.admin.client);
    const user = userEvent.setup();
    const section = await screen.findByRole("region", { name: "Worker pools" }, { timeout: 5000 });
    await user.selectOptions(await within(section).findByLabelText("Project"), "acme/svc");
    await waitFor(() => expect(section.textContent).toContain("runners"));
    expect(within(section).queryByRole("button", { name: "Check health" })).toBeNull();
    await user.selectOptions(within(section).getByLabelText("Project"), "grp/app");
    await user.click(await within(section).findByRole("button", { name: "Check health" }));
    await within(section).findByRole("columnheader", { name: "Health in grp/app" });
    // asked of GitLab, through the GitLab connection and not the GitHub one that came first
    expect(s.lab.requests.some((r) => r.path.endsWith("/runners"))).toBe(true);
    expect(s.hub.requests.some((r) => r.path.endsWith("/runners"))).toBe(false);
  });

  test("the pipeline offers the connections of the project's forge, named for it", async () => {
    const s = await scene();
    await twoProjects(s);
    window.location.hash = "#/pipeline";
    mount(s.admin.client);
    const user = userEvent.setup();
    const connections = async (project: string, label: string) => {
      await user.selectOptions(await screen.findByLabelText("Project"), project);
      await user.click(await screen.findByRole("button", { name: "Choose a template" }));
      await user.click(await screen.findByRole("radio", { name: /^bun-app / }));
      await user.click(screen.getByRole("button", { name: "Next" }));
      const select = (await screen.findByLabelText(label)) as HTMLSelectElement;
      return Array.from(select.options).map((o) => o.textContent);
    };
    expect(await connections("acme/svc", "GitHub connection")).toEqual(["hub"]);
  });

  test("a GitHub project's pipeline is previewed through the GitHub connection, though a GitLab one came first", async () => {
    const s = await scene();
    await s.gitlab();
    const hubConnection = await s.github();
    const repo = s.hub.addRepo("acme", "svc", { files: { "bun.lock": "", "package.json": "{}" } });
    await createProject(backend.t.db, {
      organizationId: s.org.id,
      name: "acme/svc",
      gitlabProjectId: repo.id,
      connectionId: hubConnection.id,
    });
    window.location.hash = "#/pipeline";
    mount(s.admin.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Choose a template" }));
    await user.click(await screen.findByRole("radio", { name: /^bun-app / }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    const preview = (await screen.findByRole("button", {
      name: "Preview pipeline",
    })) as HTMLButtonElement;
    await waitFor(() => expect(preview.disabled).toBe(false));
    await user.click(preview);
    await screen.findByRole("region", { name: "Step 4: Review" });
    expect(s.hub.requests.length).toBeGreaterThan(0);
  });

  test("a cloud account is not a forge connection", async () => {
    const s = await scene();
    await s.github();
    await createConnection(
      backend.t.db,
      envKeyProvider(`k1:${Buffer.alloc(32, 9).toString("base64")}`),
      {
        organizationId: s.org.id,
        type: "aws",
        name: "cloud",
        config: { roleArn: "arn:aws:iam::123456789012:role/orch", region: "eu-west-1" },
        token: "external-id-1234",
      },
    );
    window.location.hash = "#/settings";
    mount(s.admin.client);
    const table = await screen.findByRole("table", { name: "Connections" }, { timeout: 5000 });
    expect(within(table).getByRole("rowheader", { name: "hub" })).toBeTruthy();
    expect(within(table).queryByRole("rowheader", { name: "cloud" })).toBeNull();
  });

  test("the connections table says which forge each is", async () => {
    const s = await scene();
    await twoProjects(s);
    window.location.hash = "#/settings";
    mount(s.admin.client);
    const table = await screen.findByRole("table", { name: "Connections" }, { timeout: 5000 });
    const forgeOf = (name: string) =>
      within(table).getByRole("rowheader", { name }).closest("tr")?.children[1]?.textContent;
    expect([forgeOf("hub"), forgeOf("lab")]).toEqual(["GitHub", "GitLab"]);
  });
});
