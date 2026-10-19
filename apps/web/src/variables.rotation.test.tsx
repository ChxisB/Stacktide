import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { variableRotations } from "@orch/db";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eq } from "drizzle-orm";
import { type Backend, mount, startBackend } from "./testing";
import { cellOf, must, SECRET, scene as sceneOn } from "./variables.fixture";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
const scene = (options?: { reporter?: boolean; environments?: string[] }) =>
  sceneOn(backend, options);
beforeEach(() => {
  window.location.hash = "#/variables";
  try {
    localStorage.clear();
  } catch {
    // the page copes without it
  }
});

type User = ReturnType<typeof userEvent.setup>;
type Scene = Awaited<ReturnType<typeof scene>>;

/** A rotation as a person sets it up (the command line does the same): the `random` provider. */
const rotate = async (s: Scene, varId: string, extra: { graceDays?: number } = {}) =>
  must(
    await s.scope.variables({ varId }).rotation.put({
      provider: "random",
      intervalDays: 30,
      graceDays: 0,
      enabled: true,
      ...extra,
    }),
  );

/** The panel once it has loaded (it says "Loading rotation" until then). */
const panelOf = async (key: string) => {
  const region = await screen.findByRole("region", { name: `Rotation of ${key}` });
  await waitFor(() => expect(region.querySelector("[aria-busy]") === null).toBe(true));
  return region;
};
const openPanel = async (user: User, key: string, env: string) => {
  await user.click(
    within(cellOf(key, env)).getByRole("button", { name: `Rotation of ${key} in ${env}` }),
  );
  return panelOf(key);
};
const buttonsOf = (region: HTMLElement) =>
  within(region)
    .getAllByRole("button")
    .map((b) => b.textContent);

describe("the rotation panel", () => {
  test("only a secret has one: a plain variable offers no Rotation button", async () => {
    const s = await scene();
    await s.put.project("REGION", "eu");
    await s.put.project("API_KEY", SECRET, true);
    mount(s.client);
    await screen.findByRole("table");
    expect(
      within(cellOf("REGION", "dev")).queryByRole("button", { name: /^Rotation of/ }),
    ).toBeNull();
    expect(
      within(cellOf("API_KEY", "dev")).getByRole("button", { name: "Rotation of API_KEY in dev" }),
    ).toBeTruthy();
  });

  test("a secret that does not rotate says so and points at the command that sets one", async () => {
    const s = await scene();
    await s.put.project("API_KEY", SECRET, true);
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openPanel(user, "API_KEY", "dev");
    expect(region.textContent).toContain("API_KEY does not rotate");
    expect(region.textContent).toContain(
      "orch rotation set API_KEY --provider random --interval 30",
    );
    // nothing to switch or run, only to leave
    expect(buttonsOf(region)).toEqual(["Close"]);
    await user.click(within(region).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "Rotation of API_KEY" })).toBeNull();
  });

  test("never rotated: the provider, the schedule and when it is next due", async () => {
    const s = await scene();
    const v = await s.put.project("API_KEY", SECRET, true);
    await rotate(s, v.id, { graceDays: 2 });
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openPanel(user, "API_KEY", "dev");
    const text = region.textContent ?? "";
    expect(text).toContain("random, every 30 days, with 2 days of grace");
    expect(text).toContain("Never rotated.");
    expect(text).toMatch(/Next run: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
    expect(region.querySelector("time")?.getAttribute("datetime")).toMatch(
      /^\d{4}-\d{2}-\d{2}T.*Z$/,
    );
    expect(text).not.toContain("Switched off");
    expect(buttonsOf(region)).toEqual(["Switch off", "Rotate now", "Close"]);
    expect(text.includes(SECRET)).toBe(false);
  });

  test("rotate now asks first: cancel changes nothing; confirming makes a new version and shows it was done, never the value", async () => {
    const s = await scene();
    const v = await s.put.project("API_KEY", SECRET, true);
    await rotate(s, v.id);
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByRole("table");
    let region = await openPanel(user, "API_KEY", "dev");

    await user.click(within(region).getByRole("button", { name: "Rotate now" }));
    const form = screen.getByRole("form", { name: "Rotate API_KEY now" });
    expect(form.textContent).toContain("stops being the variable's current version");
    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    region = await panelOf("API_KEY");
    expect(await s.audit("variable.rotation.run")).toHaveLength(0);
    expect(must(await s.scope.variables({ varId: v.id }).get()).version).toBe(1);

    await user.click(within(region).getByRole("button", { name: "Rotate now" }));
    await user.click(screen.getByRole("button", { name: "Rotate now" }));
    region = await panelOf("API_KEY");
    await waitFor(() => expect(region.textContent).toContain("Last rotated"));
    expect(region.textContent).toContain("Rotated: API_KEY is now version 2");
    expect(region.textContent).not.toContain("Never rotated");
    expect(must(await s.scope.variables({ varId: v.id }).get()).version).toBe(2);
    expect(await s.audit("variable.rotation.run")).toHaveLength(1);

    // the new value is read like any other secret's, and it is not the old one
    const fresh = must(await s.scope.variables({ varId: v.id }).value.get({ query: {} })).value;
    expect(fresh).not.toBe(SECRET);
    expect(document.body.textContent?.includes(fresh)).toBe(false);
    expect(document.body.textContent?.includes(SECRET)).toBe(false);
  });

  test("a failing rotation says why, how often, and that the current value is still in use", async () => {
    const s = await scene();
    const v = await s.put.project("API_KEY", SECRET, true);
    await rotate(s, v.id);
    await backend.t.db
      .update(variableRotations)
      .set({ lastStatus: "failing", lastError: "denied", attempts: 3, lastAt: new Date() })
      .where(eq(variableRotations.variableId, v.id));
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openPanel(user, "API_KEY", "dev");
    const failing = region.querySelector("p.error");
    expect(failing?.textContent).toBe(
      "Failing: denied, 3 failed in a row. The current value is still in use.",
    );
    expect(region.textContent).toMatch(/Last attempted \d{4}-\d{2}-\d{2}/);
  });

  test("a run the provider cannot do is said in the confirmation, and the panel then counts it", async () => {
    const s = await scene();
    const v = await s.put.project("API_KEY", SECRET, true);
    await rotate(s, v.id);
    // a stored config the provider can no longer read: written below the API's own check
    await backend.t.db
      .update(variableRotations)
      .set({ config: { length: 1 } })
      .where(eq(variableRotations.variableId, v.id));
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openPanel(user, "API_KEY", "dev");
    await user.click(within(region).getByRole("button", { name: "Rotate now" }));
    await user.click(screen.getByRole("button", { name: "Rotate now" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("no longer suit its provider");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    const again = await panelOf("API_KEY");
    await waitFor(() =>
      expect(again.textContent).toContain(
        "The last attempt failed: invalid_config, 1 failed in a row",
      ),
    );
    // the value was not touched
    expect(must(await s.scope.variables({ varId: v.id }).get()).version).toBe(1);
  });

  test("on a protected environment rotating waits for approval, and the panel says so", async () => {
    const s = await scene();
    const staging = s.scope.environments({ envId: s.envs.staging ?? "" });
    const v = must(
      await staging.variables.post({ key: "DB_PASSWORD", kind: "secret", value: SECRET }),
    );
    must(
      await staging
        .variables({ varId: v.id })
        .rotation.put({ provider: "random", intervalDays: 30, graceDays: 0, enabled: true }),
    );
    must(await staging.protection.put({ protected: true }));
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openPanel(user, "DB_PASSWORD", "staging");
    await user.click(within(region).getByRole("button", { name: "Rotate now" }));
    await user.click(screen.getByRole("button", { name: "Rotate now" }));
    const after = await panelOf("DB_PASSWORD");
    await waitFor(() => expect(after.textContent).toContain("Waiting for approval"));
    expect(after.textContent).toContain("a change request holds the new value");
    expect(after.querySelectorAll("[role=status]")).toHaveLength(1);
    // nothing was written: the current value is still version 1
    expect(must(await staging.variables({ varId: v.id }).get()).version).toBe(1);
  });

  test("switching off and on keeps the interval and the grace, and says what a switched-off rotation does", async () => {
    const s = await scene();
    const v = await s.put.project("API_KEY", SECRET, true);
    await rotate(s, v.id, { graceDays: 2 });
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByRole("table");
    let region = await openPanel(user, "API_KEY", "dev");

    await user.click(within(region).getByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(region.textContent).toContain("Switched off"));
    expect(region.textContent).toContain("It will not rotate by itself");
    expect(region.textContent).not.toContain("Next run");
    expect(buttonsOf(region)).toEqual(["Switch on", "Rotate now", "Close"]);
    expect(must(await s.scope.variables({ varId: v.id }).rotation.get())).toMatchObject({
      enabled: false,
      intervalDays: 30,
      graceDays: 2,
      provider: "random",
    });

    region = await panelOf("API_KEY");
    await user.click(within(region).getByRole("button", { name: "Switch on" }));
    await waitFor(() => expect(region.textContent).toContain("Next run"));
    expect(region.textContent).not.toContain("Switched off");
    expect(must(await s.scope.variables({ varId: v.id }).rotation.get()).enabled).toBe(true);
    expect(await s.audit("variable.rotation.set")).toHaveLength(3);
  });

  test("a reader sees the status, and a change is refused in the API's words", async () => {
    const s = await scene({ reporter: true });
    const v = await s.put.project("API_KEY", SECRET, true);
    await rotate(s, v.id);
    mount(s.client);
    const user = userEvent.setup();
    await screen.findByRole("table");
    const region = await openPanel(user, "API_KEY", "dev");
    expect(region.textContent).toContain("random, every 30 days");
    await user.click(within(region).getByRole("button", { name: "Switch off" }));
    const alert = await within(region).findByRole("alert");
    expect(alert.textContent?.length).toBeGreaterThan(0);
    expect(must(await s.scope.variables({ varId: v.id }).rotation.get()).enabled).toBe(true);
  });
});
