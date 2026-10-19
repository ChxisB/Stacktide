import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createProject } from "@orch/db";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Backend, mount, startBackend } from "./testing";
import { must } from "./variables.fixture";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/settings";
});
afterEach(cleanup);

/** An organization with an admin, a viewer, and (when asked for) a connection to a mock GitLab with one linked project. */
async function world({ connected = true, linked = true } = {}) {
  const org = await backend.organization();
  const admin = await backend.signIn(`admin of ${org.slug}`, {
    orgRoles: { [org.id]: "admin" },
    projectRoles: {},
  });
  const viewer = await backend.signIn(`viewer of ${org.slug}`, {
    orgRoles: { [org.id]: "viewer" },
    projectRoles: {},
  });
  const mock = backend.gitlab();
  const path = `acme/web-${org.slug}`;
  await createProject(backend.t.db, {
    organizationId: org.id,
    name: "web",
    ...(linked && { gitlabProjectId: mock.addProject({ path }).id }),
  });
  const scope = admin.client.organizations({ orgId: org.id });
  if (connected) {
    must(
      await scope.connections.post({
        type: "gitlab",
        name: "Mock GitLab",
        baseUrl: mock.url,
        token: mock.token,
      }),
    );
  }
  const pool = async (
    name: string,
    tags: string[],
    more: { image?: string; enabled?: boolean; isDefault?: boolean } = {},
  ) => must(await scope.pools.post({ name, tags, ...more }));
  return { org, admin, viewer, mock, path, pool };
}

const region = () => screen.findByRole("region", { name: "Worker pools" }, { timeout: 5000 });
const rowOf = (section: HTMLElement, name: string) => {
  const tr = within(section).getByRole("rowheader", { name }).closest("tr");
  if (!tr) throw new Error(`no row for ${name}`);
  return tr;
};
const check = async () =>
  userEvent.setup().click(await screen.findByRole("button", { name: "Check health" }));

describe("the pools section of the settings page", () => {
  test("an organization with none says so, and says that tags route and do not isolate", async () => {
    const w = await world();
    mount(w.admin.client);
    const section = await region();
    await waitFor(() => expect(section.textContent).toContain("No pool yet"), { timeout: 5000 });
    expect(section.textContent).toContain("do not isolate");
    expect(within(section).queryByRole("table")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Check health" })).toBeNull();
  });

  test("lists each pool: tags, image, whether it is enabled and which is the default", async () => {
    const w = await world();
    await w.pool("plain", ["prod-runners"]);
    await w.pool("custom", ["prod-runners", "gpu"], {
      image: "registry.example.com/iac:1",
      isDefault: true,
    });
    await w.pool("parked", ["spare"], { enabled: false });
    mount(w.admin.client);
    const section = await region();
    await within(section).findByRole("rowheader", { name: "plain" }, { timeout: 5000 });
    expect(rowOf(section, "plain").textContent).toContain("prod-runners");
    expect(rowOf(section, "plain").textContent).toContain("Enabled");
    expect(rowOf(section, "custom").textContent).toContain("prod-runners");
    expect(rowOf(section, "custom").textContent).toContain("gpu");
    expect(rowOf(section, "custom").textContent).toContain("registry.example.com/iac:1");
    expect(rowOf(section, "custom").textContent).toContain("Default");
    expect(rowOf(section, "parked").textContent).toContain("Disabled");
    expect(rowOf(section, "plain").textContent).not.toContain("Default");
  });

  test("a viewer reads the pools and has no way to ask GitLab about them", async () => {
    const w = await world();
    await w.pool("prod", ["prod-runners"]);
    mount(w.viewer.client);
    const section = await region();
    await within(section).findByRole("rowheader", { name: "prod" }, { timeout: 5000 });
    expect(within(section).queryByRole("button", { name: "Check health" })).toBeNull();
  });

  test("an admin of an organization with no GitLab connection is told what is missing", async () => {
    const w = await world({ connected: false });
    await w.pool("prod", ["prod-runners"]);
    mount(w.admin.client);
    const section = await region();
    await within(section).findByRole("rowheader", { name: "prod" }, { timeout: 5000 });
    await waitFor(() => expect(section.textContent).toContain("needs a GitLab connection"));
    expect(within(section).queryByRole("button", { name: "Check health" })).toBeNull();
  });
});

describe("a pool's health, as GitLab shows it for a project", () => {
  test("healthy and degraded, with how many runners are online", async () => {
    const w = await world();
    await w.pool("prod", ["prod-runners"]);
    w.mock.addRunner(w.path, { tags: ["prod-runners"] });
    mount(w.admin.client);
    const section = await region();
    await within(section).findByRole("rowheader", { name: "prod" }, { timeout: 5000 });
    // nothing is asked of GitLab until someone asks
    expect(w.mock.requests.filter((r) => r.path.endsWith("/runners"))).toHaveLength(0);
    await check();
    await waitFor(() => expect(rowOf(section, "prod").textContent).toContain("Healthy"), {
      timeout: 5000,
    });
    expect(rowOf(section, "prod").textContent).toContain("1 of 1 runners online");

    w.mock.addRunner(w.path, { tags: ["prod-runners"], status: "offline" });
    await check();
    await waitFor(() => expect(rowOf(section, "prod").textContent).toContain("Degraded"), {
      timeout: 5000,
    });
    expect(rowOf(section, "prod").textContent).toContain("1 of 2 runners online");
  });

  test("no runner with the pool's tags is offline, not healthy", async () => {
    const w = await world();
    await w.pool("idle", ["nobody-has-this"]);
    mount(w.admin.client);
    const section = await region();
    await within(section).findByRole("rowheader", { name: "idle" }, { timeout: 5000 });
    await check();
    await waitFor(() => expect(rowOf(section, "idle").textContent).toContain("Offline"), {
      timeout: 5000,
    });
    expect(rowOf(section, "idle").textContent).toContain("0 of 0 runners online");
  });

  test("a token that may not list runners reads as not known, and says why: never healthy", async () => {
    const w = await world();
    await w.pool("prod", ["prod-runners"]);
    w.mock.addRunner(w.path, { tags: ["prod-runners"] });
    w.mock.inject({ method: "GET", path: /\/runners$/, status: 403 });
    mount(w.admin.client);
    const section = await region();
    await within(section).findByRole("rowheader", { name: "prod" }, { timeout: 5000 });
    await check();
    await waitFor(() => expect(rowOf(section, "prod").textContent).toContain("Not known"), {
      timeout: 5000,
    });
    expect(rowOf(section, "prod").textContent).toContain(
      "the connection's token cannot list the project's runners",
    );
    expect(rowOf(section, "prod").textContent).not.toContain("Healthy");
  });

  test("a project that is not on GitLab has nothing to ask, and GitLab is not asked", async () => {
    const w = await world({ linked: false });
    await w.pool("prod", ["prod-runners"]);
    mount(w.admin.client);
    const section = await region();
    await within(section).findByRole("rowheader", { name: "prod" }, { timeout: 5000 });
    await check();
    await waitFor(() => expect(rowOf(section, "prod").textContent).toContain("Not known"), {
      timeout: 5000,
    });
    expect(rowOf(section, "prod").textContent).toContain("the project is not on GitLab");
    expect(w.mock.requests.filter((r) => r.path.endsWith("/runners"))).toHaveLength(0);
  });

  test("a failed check is said, and the pools stay listed", async () => {
    const w = await world();
    await w.pool("prod", ["prod-runners"]);
    w.mock.inject({ method: "GET", path: /\/runners$/, status: 502, times: 5 });
    mount(w.admin.client);
    const section = await region();
    await within(section).findByRole("rowheader", { name: "prod" }, { timeout: 5000 });
    await check();
    await waitFor(
      () => expect(rowOf(section, "prod").textContent).toContain("GitLab did not answer"),
      {
        timeout: 5000,
      },
    );
    expect(rowOf(section, "prod").textContent).not.toContain("Healthy");
  });
});
