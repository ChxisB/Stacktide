import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createClient } from "@orch/api-client";
import { auditEvents } from "@orch/db";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { and, eq } from "drizzle-orm";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { OrgProvider } from "./org";
import { ErrorBoundary, type Page, Shell } from "./shell";
import { type Backend, mount, startBackend } from "./testing";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());

describe("signed out", () => {
  test("a visitor lands on the login page, with no navigation", async () => {
    mount(backend.anonymous());
    const link = await screen.findByRole("link", { name: "Sign in with GitLab" });
    expect(link.getAttribute("href")).toBe("/auth/login?return_to=/");
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });

  test("GitHub is offered beside GitLab, as a full page navigation to the API", async () => {
    mount(backend.anonymous());
    const link = await screen.findByRole("link", { name: "Sign in with GitHub" });
    expect(link.getAttribute("href")).toBe("/auth/github/login?return_to=/");
  });

  test("an organization's own provider is offered by its slug, and only once one is typed", async () => {
    mount(backend.anonymous());
    await screen.findByRole("link", { name: "Sign in with GitLab" });
    expect(screen.queryByRole("link", { name: "Sign in with single sign-on" })).toBeNull();
    await userEvent.setup().type(await screen.findByLabelText("Organization slug"), " acme/x ");
    const link = await screen.findByRole("link", { name: "Sign in with single sign-on" });
    expect(link.getAttribute("href")).toBe("/auth/sso/acme%2Fx/login?return_to=/");
  });

  // UXR-13 (feature 32): one centred card in the page's landmark, the one h1, and the slug's hint read with its field
  test("the login page is one card in the main landmark, under the one h1, with the slug's hint tied to its field", async () => {
    mount(backend.anonymous());
    await screen.findByRole("link", { name: "Sign in with GitLab" });
    const main = screen.getByRole("main");
    expect(within(main).getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(main.querySelectorAll(".card")).toHaveLength(1);
    const slug = screen.getByLabelText("Organization slug");
    const hint = document.getElementById(slug.getAttribute("aria-describedby") ?? "");
    expect(hint?.textContent).toMatch(/slug/i);
    // the heading over the field names the way in, and is the second level
    expect(
      within(main).getByRole("heading", { level: 2, name: "Or through your organization" }),
    ).toBeTruthy();
  });

  test("a session that has ended is a visitor too", async () => {
    const { client } = await backend.signIn("Gone Soon");
    await client.auth.logout.post({});
    mount(client);
    expect(await screen.findByRole("link", { name: "Sign in with GitLab" })).toBeTruthy();
  });

  test("a server that cannot be reached is an error with a way to retry, not a login page", async () => {
    mount(createClient("http://127.0.0.1:1"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Cannot reach the server");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in with GitLab" })).toBeNull();
  });

  // UXR-13: the same alert, now a bad callout (its glyph and its words), in the same centred card as the login page
  test("that error is a bad callout in the centred card, with its title and the server's words", async () => {
    mount(createClient("http://127.0.0.1:1"));
    const alert = await screen.findByRole("alert");
    expect(alert.classList.contains("callout-bad")).toBe(true);
    expect(alert.textContent).toContain("Something went wrong");
    expect(alert.querySelector("svg")).toBeTruthy();
    expect(screen.getByRole("main").querySelectorAll(".card")).toHaveLength(1);
  });
});

describe("a server that comes back", () => {
  test("Try again asks again, and the user lands in the shell", async () => {
    const { cookie } = await backend.signIn("Back Again");
    let down = true;
    const flaky = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        down ? Promise.reject(new TypeError("fetch failed")) : fetch(input, init),
      { preconnect: fetch.preconnect },
    );
    mount(createClient(backend.api, { headers: { cookie }, fetcher: flaky }));
    await screen.findByRole("alert");
    down = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Back Again")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("signed in", () => {
  test("the shell shows who is signed in, the navigation and the home page", async () => {
    const { client } = await backend.signIn("Ada Lovelace");
    const { settled } = mount(client);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(nav.textContent).toContain("Home");
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in with GitLab" })).toBeNull();
    expect(screen.getByRole("button", { name: "Skip to content" })).toBeTruthy();
    await settled();
  });

  test("signing out ends the session on the server and shows the login page", async () => {
    const { client, user } = await backend.signIn("Grace Hopper");
    mount(client);
    await screen.findByText("Grace Hopper");
    window.location.hash = "#/variables";
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Sign in with GitLab" })).toBeTruthy();
    expect((await client.auth.me.get()).status).toBe(401);
    expect(screen.queryByText("Grace Hopper")).toBeNull();
    const audit = await backend.t.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "auth.logout"), eq(auditEvents.resourceId, user.id)));
    expect(audit).toHaveLength(1);
    expect(window.location.hash).toBe("");
  });
});

describe("signing out, when it does not go to plan", () => {
  test("a session that has already ended still ends in the login page", async () => {
    const { client } = await backend.signIn("Already Gone");
    const { settled } = mount(client);
    await screen.findByText("Already Gone");
    await settled();
    await client.auth.logout.post(); // from another tab, say
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Sign in with GitLab" })).toBeTruthy();
  });

  test("a failed sign-out says so, and the user is still signed in", async () => {
    const { cookie } = await backend.signIn("Stays Put");
    const logoutFails = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) =>
        new Request(input, init).url.endsWith("/auth/logout")
          ? Promise.resolve(
              Response.json(
                { type: "x", title: "Oops", status: 500, code: "internal", detail: "Try later." },
                { status: 500 },
              ),
            )
          : fetch(input, init),
      { preconnect: fetch.preconnect },
    );
    const failing = createClient(backend.api, { headers: { cookie }, fetcher: logoutFails });
    mount(failing);
    await screen.findByText("Stays Put");
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Try later.");
    expect(screen.getByText("Stays Put")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Sign in with GitLab" })).toBeNull();
  });

  test("a session that ends on its own leaves nothing for the next user", async () => {
    const { client } = await backend.signIn("Timed Out");
    const { queries, settled } = mount(client);
    await screen.findByText("Timed Out");
    await settled();
    expect(queries.getQueryData(["orgs"])).toBeDefined();
    await client.auth.logout.post(); // the session ends elsewhere, not through Sign out
    await act(async () => {
      await queries.invalidateQueries({ queryKey: ["me"] });
    });
    expect(await screen.findByRole("link", { name: "Sign in with GitLab" })).toBeTruthy();
    await waitFor(() => expect(queries.getQueryData(["orgs"])).toBeUndefined());
  });

  test("what was fetched as the user is forgotten", async () => {
    const { client } = await backend.signIn("Forgetful");
    const { queries } = mount(client);
    await screen.findByText("Forgetful");
    queries.setQueryData(["variables", "p1"], [{ key: "DB_HOST" }]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByRole("link", { name: "Sign in with GitLab" });
    await waitFor(() => expect(queries.getQueryData(["variables", "p1"])).toBeUndefined());
  });
});

describe("pages", () => {
  const pages: Page[] = [
    { path: "", label: "Home", element: <p>the home page</p> },
    { path: "other", label: "Other", element: <p>the other page</p> },
    {
      path: "broken",
      label: "Broken",
      element: <Boom />,
    },
  ];
  function Boom(): never {
    throw new Error("this screen broke");
  }
  const shell = async () => {
    const { client } = await backend.signIn("Page Tester");
    const queries = newQueryClient();
    render(
      <Providers client={client} queries={queries}>
        <AuthGate>
          <OrgProvider>
            <Shell pages={pages} />
          </OrgProvider>
        </AuthGate>
      </Providers>,
    );
    await screen.findByRole("navigation", { name: "Main" });
    // the organization list is still on its way, and would update the page after the test
    await waitFor(() => expect(queries.isFetching()).toBe(0));
  };

  test("the hash picks the page and marks it in the navigation; an unknown one is home", async () => {
    await shell();
    expect(screen.getByText("the home page")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBe("page");

    await act(async () => {
      window.location.hash = "#/other";
    });
    expect(await screen.findByText("the other page")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Other" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Home" }).getAttribute("aria-current")).toBeNull();

    await act(async () => {
      window.location.hash = "#/nowhere";
    });
    expect(await screen.findByText("the home page")).toBeTruthy();

    // from home, so the page can only be "other" once it has re-rendered
    await act(async () => {
      window.location.hash = "#/other?tab=2";
    });
    expect(await screen.findByText("the other page")).toBeTruthy();
  });

  test("the skip link moves focus to the page without changing it", async () => {
    await shell();
    await act(async () => {
      window.location.hash = "#/other";
    });
    await screen.findByText("the other page");
    await userEvent.setup().click(screen.getByRole("button", { name: "Skip to content" }));
    expect(window.location.hash).toBe("#/other");
    expect(document.activeElement?.id).toBe("main");
    expect(screen.getByText("the other page")).toBeTruthy();
  });

  test("a screen that throws shows an error in the page and the navigation keeps working", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    try {
      await shell();
      await act(async () => {
        window.location.hash = "#/broken";
      });
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain("this screen broke");
      await userEvent.setup().click(screen.getByRole("link", { name: "Other" }));
      expect(await screen.findByText("the other page")).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    } finally {
      quiet.mockRestore();
    }
  });

  test("the boundary offers to try the screen again", async () => {
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const Flaky = () => {
      if (fail) throw new Error("not yet");
      return <p>recovered</p>;
    };
    try {
      render(
        <ErrorBoundary>
          <Flaky />
        </ErrorBoundary>,
      );
      expect(screen.getByRole("alert").textContent).toContain("not yet");
      fail = false;
      await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
      expect(screen.getByText("recovered")).toBeTruthy();
    } finally {
      quiet.mockRestore();
    }
  });
});
