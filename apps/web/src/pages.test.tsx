import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import { type Backend, mount, startBackend } from "./testing";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());

// every screen of the app, by its route: its one h1 (which the screens' own tests look for by name)
const PAGES = [
  ["", "Welcome"],
  ["projects", "Projects"],
  ["variables", "Variables"],
  ["sync", "Sync"],
  ["pipeline", "Pipeline"],
  ["status", "Pipeline status"],
  ["findings", "Findings"],
  ["state", "State"],
  ["settings", "Settings"],
  ["organizations", "Organizations"],
] as const;

describe("page heads", () => {
  test.each(PAGES)(
    "#/%s has the heading %p, an eyebrow that is its section, and a lede",
    async (path, title) => {
      window.location.hash = `#/${path}`;
      const { client } = await backend.signIn("Head Tester");
      const { settled } = mount(client);
      const heading = await screen.findByRole("heading", { level: 1, name: title });
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      const head = heading.closest("header") as HTMLElement;
      const eyebrow = head.querySelector(".eyebrow")?.textContent;
      // the eyebrow is the sidebar's heading for the page, which the breadcrumb also shows
      const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
      expect(eyebrow).toBeTruthy();
      expect(within(crumbs).getAllByRole("listitem")[0]?.textContent).toBe(eyebrow);
      expect((head.querySelector(".lede")?.textContent ?? "").length).toBeGreaterThan(20);
      await waitFor(() => settled());
    },
  );
});
