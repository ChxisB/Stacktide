import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createProject } from "@orch/db";
import { screen, waitFor, within } from "@testing-library/react";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "";
});

async function scene(role: "admin" | "member" = "admin") {
  const org = await backend.organization();
  const mock = backend.gitlab();
  const { client, cookie } = await backend.signIn(`${role} of ${org.slug}`, {
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
  return { org, client, cookie, connect };
}

/** The overview tiles as label -> figure. */
async function tiles() {
  const overview = await screen.findByRole("region", { name: "Overview" });
  return Object.fromEntries(
    [...overview.querySelectorAll(".kpi")].map((k) => [
      k.querySelector(".kpi-label")?.textContent,
      k.querySelector(".kpi-value")?.textContent,
    ]),
  );
}

describe("the home page", () => {
  test("a new organization shows zeros above a checklist with nothing done", async () => {
    const s = await scene();
    mount(s.client);
    expect(await tiles()).toEqual({ "Projects imported": "0", "Forge connections": "0" });
    const list = screen.getByRole("region", { name: "Getting started" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  test("shows the counts once GitLab is connected and projects are imported", async () => {
    const s = await scene();
    await s.connect();
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/one" });
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/two" });
    mount(s.client);
    expect(await tiles()).toEqual({ "Projects imported": "2", "Forge connections": "1" });
    expect(
      within(screen.getByRole("region", { name: "Getting started" })).getByRole("heading", {
        name: "You are set up",
      }),
    ).toBeTruthy();
  });

  test("a member cannot read connections, so that tile is left out rather than shown as zero", async () => {
    const s = await scene("member");
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/seen" });
    mount(s.client);
    expect(await tiles()).toEqual({ "Projects imported": "1" });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Getting started" })).toBeTruthy(),
    );
  });

  test("connections that fail to load for any reason but access show no tiles, not a count left out as if unreadable", async () => {
    const s = await scene();
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/one" });
    const failing = clientVia(backend.api, s.cookie, async (request, send) =>
      pathOf(request).endsWith("/connections") ? down("boom") : send(),
    );
    const page = mount(failing);
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    await page.settled();
    expect(screen.queryByRole("region", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
  });

  test("each checklist step has a shape that is not read out, and its words say done or to do", async () => {
    const s = await scene();
    await s.connect();
    mount(s.client);
    const list = await screen.findByRole("region", { name: "Getting started" });
    const [first, second] = within(list).getAllByRole("listitem");
    for (const li of [first, second]) {
      expect(li?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(first?.textContent).toContain("(done)");
    expect(second?.textContent).toContain("(to do)");
    // done and not done look different, not only in colour
    expect(first?.querySelector("svg")?.innerHTML).not.toBe(
      second?.querySelector("svg")?.innerHTML,
    );
  });

  // UXR-14 (feature 32): how far along the setup is, as a number a screen reader gets and a bar everyone sees
  test("a progress bar says how many steps are done, from none to all", async () => {
    const s = await scene();
    mount(s.client);
    const list = await screen.findByRole("region", { name: "Getting started" });
    const bar = within(list).getByRole("progressbar", { name: "Setup progress" });
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("2");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
    expect(bar.getAttribute("aria-valuetext")).toBe("0 of 2 steps done");
    expect(within(list).getByText("0 of 2 steps done")).toBeTruthy();
  });

  test("it moves as the steps are done, and a done list is a full bar", async () => {
    const s = await scene();
    await s.connect();
    mount(s.client);
    const bar = await screen.findByRole("progressbar", { name: "Setup progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuetext")).toBe("1 of 2 steps done");
  });

  test("a full bar when both are done", async () => {
    const s = await scene();
    await s.connect();
    await createProject(backend.t.db, { organizationId: s.org.id, name: "acme/one" });
    mount(s.client);
    const bar = await screen.findByRole("progressbar", { name: "Setup progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("2");
    expect(bar.getAttribute("aria-valuemax")).toBe("2");
  });

  test("a member's list has the one step they can see, so the bar counts one", async () => {
    const s = await scene("member");
    mount(s.client);
    const bar = await screen.findByRole("progressbar", { name: "Setup progress" });
    expect(bar.getAttribute("aria-valuemax")).toBe("1");
    expect(bar.getAttribute("aria-valuenow")).toBe("0");
  });

  // a tile that has somewhere to go says so, in its foot
  test("the tiles lead on: View projects and Manage connections, each to its screen", async () => {
    const s = await scene();
    mount(s.client);
    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(within(overview).getByRole("link", { name: "View projects" }).getAttribute("href")).toBe(
      "#/projects",
    );
    expect(
      within(overview).getByRole("link", { name: "Manage connections" }).getAttribute("href"),
    ).toBe("#/settings");
  });

  test("a member has no Manage connections link, as they have no connections tile", async () => {
    const s = await scene("member");
    mount(s.client);
    const overview = await screen.findByRole("region", { name: "Overview" });
    expect(within(overview).getByRole("link", { name: "View projects" })).toBeTruthy();
    expect(within(overview).queryByRole("link", { name: "Manage connections" })).toBeNull();
  });

  test("each step is one link, which the row stretches over, so the whole row is the target", async () => {
    const s = await scene();
    mount(s.client);
    const list = await screen.findByRole("region", { name: "Getting started" });
    for (const li of within(list).getAllByRole("listitem")) {
      expect(li.querySelectorAll("a")).toHaveLength(1);
    }
  });

  // what is on its way is drawn, not left blank: the card and the tiles, under one busy marker
  test("while the connections are on their way the page shows the shape of the cards, and then the cards", async () => {
    const s = await scene();
    await s.connect();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = clientVia(backend.api, s.cookie, async (request, send) => {
      if (request.method === "GET" && pathOf(request).endsWith("/connections")) await gate;
      return send();
    });
    mount(held);
    await screen.findByRole("heading", { level: 1, name: "Welcome" });
    const busy = await waitFor(
      () => {
        const grid = document.querySelector('.home-grid[aria-busy="true"]');
        expect(grid).toBeTruthy();
        return grid as Element;
      },
      { timeout: 5000 },
    );
    expect(within(busy as HTMLElement).getByRole("status").textContent).toBe("Loading");
    expect(screen.queryByRole("region", { name: "Getting started" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Overview" })).toBeNull();
    release();
    await screen.findByRole("region", { name: "Overview" });
    expect(document.querySelector('.home-grid[aria-busy="true"]')).toBeNull();
  }, 15_000);
});
