import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { useToast } from "./components";
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
  { path: "report", label: "Report", element: <Reports /> },
  { path: "broken", label: "Broken", element: <Breaks /> },
];

function Breaks(): never {
  throw new Error("the page broke");
}

function Reports() {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast("Saved.")}>
      Report a result
    </button>
  );
}

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
  return { queries };
}

describe("the sidebar", () => {
  test("groups the links under their headings, keeps the order, and shows an icon that is not read out", async () => {
    window.location.hash = "";
    await shell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const links = within(nav)
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(links).toEqual(["Home", "Runs", "Keys", "Bare", "Report", "Broken"]);
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

  // UXR-11: the current page is no longer the one filled item, so the contract is the attribute, on one link only
  test("exactly one link says it is the current page, and the breadcrumb ends on the same page", async () => {
    window.location.hash = "#/keys";
    await shell();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const current = nav.querySelectorAll('a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe("Keys");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(crumbs)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Governance", "Keys"]);
    expect(crumbs.querySelector('[aria-current="page"]')?.textContent).toBe("Keys");
  });

  test("has the person's name and Sign out, and the brand links home", async () => {
    window.location.hash = "";
    await shell();
    expect(screen.getByText("Shell Tester")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Orchastrature/ }).getAttribute("href")).toBe("#/");
  });
});

// UXR-12: below 900 px the sidebar is a menu. It is the same <aside>, so it is a dialog only while open; the stylesheet
// (not loaded here) shows it at the left edge on a phone and keeps it in its column on a desktop.
describe("the phone menu", () => {
  const openMenu = async () => {
    window.location.hash = "";
    await shell();
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Open menu" });
    await user.click(button);
    return { user, button, menu: screen.getByRole("dialog", { name: "Menu" }) };
  };

  test("closed, the sidebar is not a dialog and the button says so; the button opens it onto its Close button", async () => {
    window.location.hash = "";
    await shell();
    const button = screen.getByRole("button", { name: "Open menu" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.setup().click(button);
    const menu = screen.getByRole("dialog", { name: "Menu" });
    expect(menu.getAttribute("aria-modal")).toBe("true");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    // the groups, the user and Sign out are all in it
    expect(within(menu).getByRole("navigation", { name: "Main" })).toBeTruthy();
    expect(within(menu).getByText("Shell Tester")).toBeTruthy();
    expect(within(menu).getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(document.activeElement).toBe(within(menu).getByRole("button", { name: "Close menu" }));
    expect(document.body.style.overflow).toBe("hidden");
  });

  test("Tab stays inside: from the last control to the first, and Shift+Tab the other way", async () => {
    const { user, menu } = await openMenu();
    const first = within(menu).getByRole("link", { name: /Orchastrature/ });
    const last = within(menu).getByRole("button", { name: "Sign out" });
    last.focus();
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  test("Escape closes it and the focus is back on the menu button", async () => {
    const { user, button } = await openMenu();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.body.style.overflow).toBe("");
  });

  test("the Close button and the scrim close it, and the focus returns", async () => {
    const { user, button, menu } = await openMenu();
    await user.click(within(menu).getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    const scrim = document.querySelector(".menu-scrim");
    expect(scrim?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(scrim as Element);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("choosing a link closes it, the page's own link too; a route change from elsewhere closes it as well", async () => {
    const { user, button, menu } = await openMenu();
    await user.click(within(menu).getByRole("link", { name: "Home" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(button);
    expect(screen.getByRole("dialog", { name: "Menu" })).toBeTruthy();
    // happy-dom fires hashchange on a later task, so the act waits for it (a waitFor over queryByRole does not settle against this tree)
    await act(async () => {
      window.location.hash = "#/keys";
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  test("growing past 900 px closes it, so a desktop layout is never trapped in a menu", async () => {
    const real = window.matchMedia;
    let narrow = true;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) =>
      query.includes("900px")
        ? {
            get matches() {
              return narrow;
            },
            addEventListener: (_: string, f: () => void) => listeners.add(f),
            removeEventListener: (_: string, f: () => void) => listeners.delete(f),
          }
        : {
            matches: false,
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as typeof window.matchMedia;
    try {
      await openMenu();
      narrow = false;
      act(() => {
        for (const f of listeners) f();
      });
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});

// UXR-9: the shell mounts the one Toaster, so any page can report a result and none has to carry its own
describe("the toaster", () => {
  test("a page reports through the shell's one status region, which is there before the result", async () => {
    window.location.hash = "#/report";
    await shell();
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Report a result" }));
    // the same element, now with the words: a screen reader hears the change
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toBe("Saved.");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(region.textContent).toBe("");
  });
});

// UXR-10: the page enters when the route changes. What triggers it is the page's own wrapper being new, so a data refresh,
// which re-renders the page in place, cannot trigger it, and nothing inside the page has to know.
describe("the page enter", () => {
  const wrapper = () => document.querySelector("main > div");

  test("the page is in one wrapper; a refetch keeps it, and a route change replaces it", async () => {
    window.location.hash = "";
    const { queries } = await shell();
    const first = wrapper();
    expect(first?.textContent).toBe("the home page");
    await act(async () => {
      await queries.invalidateQueries();
    });
    expect(wrapper()).toBe(first);
    await act(async () => {
      window.location.hash = "#/runs";
    });
    await waitFor(() => expect(wrapper()?.textContent).toBe("the runs page"));
    expect(wrapper()).not.toBe(first);
  });

  test("the page the app opens on does not animate; every page reached by a route change does, going back too", async () => {
    window.location.hash = "";
    await shell();
    expect(wrapper()?.classList.contains("page-enter")).toBe(false);
    await act(async () => {
      window.location.hash = "#/runs";
    });
    await waitFor(() => expect(wrapper()?.classList.contains("page-enter")).toBe(true));
    await act(async () => {
      window.location.hash = "";
    });
    await waitFor(() => expect(wrapper()?.textContent).toBe("the home page"));
    expect(wrapper()?.classList.contains("page-enter")).toBe(true);
  });

  test("a page that throws is shown in the wrapper, and leaving it gives a fresh page", async () => {
    window.location.hash = "#/broken";
    await shell();
    expect(wrapper()?.textContent).toContain("broke");
    await act(async () => {
      window.location.hash = "#/runs";
    });
    await waitFor(() => expect(wrapper()?.textContent).toBe("the runs page"));
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
