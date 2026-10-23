import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "./components";
import { initTheme } from "./theme";

const root = document.documentElement;
const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed") === "true";

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("data-theme");
});
afterEach(() => {
  localStorage.clear();
  root.removeAttribute("data-theme");
});

describe("the theme toggle", () => {
  test("choosing a theme sets the attribute and is read back on the next mount", async () => {
    const first = render(<ThemeToggle />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Dark" }));
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(pressed("Dark")).toBe(true);
    expect(pressed("Light")).toBe(false);
    first.unmount();

    // a new page load: the attribute is gone until the stored choice is applied at start-up
    root.removeAttribute("data-theme");
    initTheme();
    expect(root.getAttribute("data-theme")).toBe("dark");
    render(<ThemeToggle />);
    expect(pressed("Dark")).toBe(true);
  });

  test("with no choice made the page follows the system and sets no attribute", () => {
    initTheme();
    render(<ThemeToggle />);
    expect(root.hasAttribute("data-theme")).toBe(false);
    // one of the two is shown as current, so the control never reads as unset
    expect(Number(pressed("Dark")) + Number(pressed("Light"))).toBe(1);
  });

  test("with no choice made it follows the system when that changes while the page is open", () => {
    const real = window.matchMedia;
    let dark = false;
    const listeners = new Set<() => void>();
    window.matchMedia = (() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, f: () => void) => listeners.add(f),
      removeEventListener: (_: string, f: () => void) => listeners.delete(f),
    })) as unknown as typeof window.matchMedia;
    try {
      render(<ThemeToggle />);
      expect(pressed("Light")).toBe(true);
      dark = true;
      act(() => {
        for (const f of listeners) f();
      });
      expect(pressed("Dark")).toBe(true);
    } finally {
      window.matchMedia = real;
    }
  });

  test("storage that throws leaves the toggle working for the session", async () => {
    const get = spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      initTheme();
      render(<ThemeToggle />);
      await userEvent.setup().click(screen.getByRole("button", { name: "Light" }));
      expect(root.getAttribute("data-theme")).toBe("light");
      expect(pressed("Light")).toBe(true);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  test("it is reachable and operable by keyboard", async () => {
    render(<ThemeToggle />);
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dark" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Light" }));
    await user.keyboard("{Enter}");
    expect(root.getAttribute("data-theme")).toBe("light");
    await user.tab({ shift: true });
    await user.keyboard(" ");
    expect(root.getAttribute("data-theme")).toBe("dark");
  });

  test("the pair is a labelled group", () => {
    render(<ThemeToggle />);
    expect(screen.getByRole("group", { name: "Colour theme" })).toBeTruthy();
  });
});

describe("the first paint", () => {
  test("index.html applies the stored theme itself, in the head, before the stylesheet is used", async () => {
    const html = await Bun.file(`${import.meta.dir}/../index.html`).text();
    const head = html.slice(0, html.indexOf("</head>"));
    // an inline script, not the module: a module runs after the page has already painted
    const inline = head.match(/<script>([^<]*)<\/script>/)?.[1] ?? "";
    expect(inline).toContain("orch.theme");
    expect(inline).toContain("data-theme");
    // and it says the same as initTheme(): only "dark" and "light" are taken from storage
    root.removeAttribute("data-theme");
    localStorage.setItem("orch.theme", "dark");
    new Function(inline)();
    expect(root.getAttribute("data-theme")).toBe("dark");
    root.removeAttribute("data-theme");
    localStorage.setItem("orch.theme", "purple");
    new Function(inline)();
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});
