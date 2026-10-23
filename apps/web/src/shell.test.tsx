import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { OrgProvider } from "./org";
import { type Page, Shell } from "./shell";
import { type Backend, startBackend } from "./testing";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());

const pages: Page[] = [
  { path: "", label: "Home", group: "Delivery", icon: "grid", element: <p>the home page</p> },
  { path: "runs", label: "Runs", group: "Delivery", icon: "flow", element: <p>the runs page</p> },
  { path: "keys", label: "Keys", group: "Governance", icon: "sliders", element: <p>the keys</p> },
  { path: "bare", label: "Bare", element: <p>a page with no group</p> },
];

async function shell() {
  const { client } = await backend.signIn("Shell Tester");
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
}

describe("the sidebar", () => {
  test("groups the links under their headings, keeps the order, and shows an icon that is not read out", async () => {
    window.location.hash = "";
    await shell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav)
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(links).toEqual(["Home", "Runs", "Keys", "Bare"]);
    for (const heading of ["Delivery", "Governance"])
      expect(within(nav).getByText(heading)).toBeTruthy();
    // an icon is decoration: the link's name is its label
    for (const svg of nav.querySelectorAll("svg"))
      expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(within(nav).getByRole("link", { name: "Home" }).querySelector("svg")).not.toBeNull();
    expect(within(nav).getByRole("link", { name: "Bare" }).querySelector("svg")).toBeNull();
  });

  test("the current page is marked in the navigation and follows the hash", async () => {
    window.location.hash = "#/runs";
    await shell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const current = (name: string) =>
      within(nav).getByRole("link", { name }).getAttribute("aria-current");
    expect(current("Runs")).toBe("page");
    await act(async () => {
      window.location.hash = "#/keys";
    });
    await waitFor(() => expect(current("Keys")).toBe("page"));
    expect(current("Runs")).toBeNull();
  });

  test("has the person's name and Sign out, and the brand links home", async () => {
    window.location.hash = "";
    await shell();
    expect(screen.getByText("Shell Tester")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Orchastrature/ }).getAttribute("href")).toBe("#/");
  });
});

describe("the top bar", () => {
  test("the breadcrumb names the section and the page, and follows the route", async () => {
    window.location.hash = "#/keys";
    await shell();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(crumbs)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Governance", "Keys"]);
    expect(within(crumbs).getByText("Keys").getAttribute("aria-current")).toBe("page");
    await act(async () => {
      window.location.hash = "#/runs";
    });
    await waitFor(() =>
      expect(
        within(crumbs)
          .getAllByRole("listitem")
          .map((li) => li.textContent),
      ).toEqual(["Delivery", "Runs"]),
    );
  });

  test("a page with no section is just itself", async () => {
    window.location.hash = "#/bare";
    await shell();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(crumbs)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Bare"]);
  });

  test("holds the theme toggle", async () => {
    window.location.hash = "";
    await shell();
    expect(screen.getByRole("group", { name: "Colour theme" })).toBeTruthy();
  });
});
