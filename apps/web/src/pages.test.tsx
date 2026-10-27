import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { type Backend, mount, startBackend } from "./testing";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());

// every screen of the app, by its route: its one h1 (which the screens' own tests look for by name), and the section
// the sidebar and the breadcrumb put it in
const PAGES = [
  ["", "Welcome", "Delivery"],
  ["projects", "Projects", "Delivery"],
  ["variables", "Variables", "Governance"],
  ["sync", "Sync", "Infrastructure"],
  ["pipeline", "Pipeline", "Delivery"],
  ["status", "Pipeline status", "Delivery"],
  ["findings", "Findings", "Governance"],
  ["state", "State", "Infrastructure"],
  ["settings", "Settings", "Governance"],
  ["organizations", "Organizations", "Governance"],
] as const;

describe("page heads", () => {
  // UXR-31: the design has no eyebrow above a title; the section is the breadcrumb's first item
  test.each(PAGES)(
    "#/%s has the heading %p and a lede, no eyebrow, and the breadcrumb says it is in %p",
    async (path, title, section) => {
      window.location.hash = `#/${path}`;
      const { client } = await backend.signIn("Head Tester");
      const { settled } = mount(client);
      const heading = await screen.findByRole("heading", { level: 1, name: title });
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      const head = heading.closest("header") as HTMLElement;
      expect(head.querySelectorAll(".eyebrow").length).toBe(0);
      const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
      expect(within(crumbs).getAllByRole("listitem")[0]?.textContent).toBe(section);
      expect((head.querySelector(".lede")?.textContent ?? "").length).toBeGreaterThan(20);
      await waitFor(() => settled());
    },
  );
});
