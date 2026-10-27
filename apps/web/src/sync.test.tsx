import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { recordDrift } from "@orch/db";
import { createGitlab } from "@orch/gitlab";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { Toaster } from "./components";
import { OrgProvider, RequireOrg } from "./org";
import { SyncPage } from "./sync";
import { type Backend, clientVia, down, mount, pathOf, startBackend } from "./testing";
import { must, ref, SECRET, scene as sceneOn } from "./variables.fixture";

let backend: Backend;
/** Each apply of the worker waits for this; a test holds it to keep one running. */
let hold: Promise<void> = Promise.resolve();
const pause = () => {
  const gate = Promise.withResolvers<void>();
  hold = gate.promise;
  return gate.resolve;
};
beforeAll(async () => {
  backend = await startBackend();
  backend.startWorker(() => hold);
});
afterAll(() => backend.stop());
beforeEach(() => {
  hold = Promise.resolve();
  window.location.hash = "#/sync";
  try {
    localStorage.clear();
  } catch {
    // the page copes without it
  }
});

let n = 0;
/**
 * A project of the scene with a target `main` on a GitLab project of its own (the mock), the
 * environment `dev` mapped to the scope `development`, and the means to look at the target.
 */
async function world(
  options: {
    reporter?: boolean;
    policy?: "ignore" | "adopt" | "prune";
    target?: boolean;
    autoSync?: boolean;
    mapping?: Record<string, string>;
  } = {},
) {
  const s = await sceneOn(backend, { reporter: options.reporter });
  const mock = backend.gitlab(undefined, ["api"]);
  const gl = mock.addProject({ path: `fx/web-${++n}` });
  mock.addMember({ project: gl.id }, mock.tokenUser.id, 40);
  const of = { project: gl.path };
  let seen = 0;
  const gitlab = createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
  const connection = must(
    await s.admin.client.organizations({ orgId: s.org.id }).connections.post({
      type: "gitlab",
      name: "Mock GitLab",
      baseUrl: mock.url,
      token: mock.token,
    }),
  );
  const target =
    options.target === false
      ? undefined
      : must(
          await s.scope["sync-targets"].post({
            name: "main",
            type: "gitlab-variables",
            connectionId: connection.id,
            config: { project: gl.path },
            environmentMapping: options.mapping ?? { dev: "development" },
            ...(options.policy ? { unmanagedPolicy: options.policy } : {}),
            ...(options.autoSync ? { autoSync: true } : {}),
          }),
        );
  return {
    ...s,
    mock,
    of,
    gitlab,
    target,
    /** Everything the target holds, as `KEY scope` -> value. */
    held: async () => {
      const found: Record<string, string> = {};
      for await (const v of gitlab.variables.list(of)) found[`${v.key} ${v.scope}`] = v.value ?? "";
      return found;
    },
    /** Requests that changed the target since `mark` (the set-up is not the screen's doing). */
    writes: () =>
      mock.requests.slice(seen).filter((r) => r.method !== "GET" && r.path.includes("/variables"))
        .length,
    mark: () => {
      seen = mock.requests.length;
    },
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** The page alone, with a short time between looks at an apply that is running. */
function mountPage(client: ReturnType<Backend["anonymous"]>, pollMs = 20) {
  const queries = newQueryClient();
  return {
    queries,
    ...render(
      <Providers client={client} queries={queries}>
        <Toaster>
          <AuthGate>
            <OrgProvider>
              <RequireOrg>{(org) => <SyncPage orgId={org.id} pollMs={pollMs} />}</RequireOrg>
            </OrgProvider>
          </AuthGate>
        </Toaster>
      </Providers>,
    ),
  };
}

const card = () => screen.findByRole("region", { name: "Sync target main" });
const plan = () => screen.findByRole("region", { name: "Plan for main" });
const rowsOf = (table: HTMLElement) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((row) => Array.from(row.children).map((c) => c.textContent));
const facts = (c: HTMLElement) =>
  Object.fromEntries(
    Array.from(c.querySelectorAll("dt")).map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]),
  );

/** A project with variables of every kind, and a target that holds some of them. */
async function filled(options: Parameters<typeof world>[0] = {}) {
  const w = await world(options);
  await w.put.project("A_PLAIN", "plain-a-value");
  await w.put.project("B_SECRET", SECRET, true);
  await w.put.project("D_CHANGED", "d-new-value");
  await w.put.project("E_SAME", "e-same-value");
  await w.put.env("dev", "F_DEV", "f-dev-value");
  await w.gitlab.variables.create(w.of, "D_CHANGED", { value: "d-old-value" });
  await w.gitlab.variables.create(w.of, "E_SAME", { value: "e-same-value" });
  w.mark();
  return w;
}
/** None of these may be anywhere on the page. */
const VALUES = [
  SECRET,
  "plain-a-value",
  "d-new-value",
  "d-old-value",
  "e-same-value",
  "f-dev-value",
];
const noValues = () => {
  for (const v of VALUES) expect(document.body.textContent).not.toContain(v);
};
const planIt = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "Plan sync" }));
  return plan();
};
/** What the plan counts, one pill each: "3 to create", "1 to change", "0 to delete". */
const counts = (p: HTMLElement) =>
  Array.from(p.querySelectorAll(".sync-counts > .sync-count")).map((e) => e.textContent);
/** The button that opens what the last sync did, and the part of the page it opens. */
const disclosure = async () => {
  const toggle = await screen.findByRole("button", { name: "What the last sync did" });
  const panel = () => document.getElementById(toggle.getAttribute("aria-controls") ?? "");
  return { toggle, panel };
};
const finished = (text: RegExp) =>
  waitFor(() => expect(facts(document.body)["Last sync"]).toMatch(text), { timeout: 5000 });

describe("before there is a target", () => {
  test("a project with none says so", async () => {
    const w = await world({ target: false });
    mountPage(w.client);
    // in a card of its own, as a target would be, and not a loose line under the picker
    const card = await screen.findByRole("region", { name: "Sync targets" });
    expect(within(card).getByText("This project has no sync targets yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan sync" })).toBeNull();
  });

  test("the page is in the navigation and shows the target's settings", async () => {
    const w = await world({ policy: "prune" });
    mount(w.client);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Sync" }).getAttribute("aria-current")).toBe(
      "page",
    );
    const c = await card();
    expect(c.textContent).toContain("GitLab CI/CD variables");
    expect(c.textContent).toContain("Variables only on the target are deleted.");
    expect(c.textContent).toContain("Syncs when you ask.");
    expect(c.textContent).toContain("dev \u2192 development");
    // nothing has run yet: no drift check, no sync
    await waitFor(() =>
      expect(facts(c)).toEqual({
        Drift: "Not checked yet",
        "Last sync": "Never synced from here.",
      }),
    );
  });
});

describe("what the target does with what only it holds", () => {
  const policies = [
    ["ignore", "info", "Variables only on the target are left alone."],
    ["adopt", "info", "Variables only on the target are listed and left alone."],
    ["prune", "warn", "Variables only on the target are deleted."],
  ] as const;
  for (const [policy, tone, sentence] of policies) {
    test(`${policy} is a ${tone} callout in the card, not part of the sub line`, async () => {
      const w = await world({ policy });
      mountPage(w.client);
      const c = await card();
      expect(c.querySelector(`.callout-${tone}`)?.textContent).toContain(sentence);
      expect(c.querySelector(".callout-warn") !== null).toBe(tone === "warn");
      // an unmanaged policy is not announced: it is how the target is set, not news
      expect(c.querySelector(".callout")?.getAttribute("role")).toBeNull();
      const sub = c.querySelector(".card-sub")?.textContent;
      expect(sub).toBe("GitLab CI/CD variables. Syncs when you ask.");
    });
  }
});

// FLW-5: the environments of a target as a flow, with the counts of an open plan on each line
describe("the flow of a target", () => {
  const strip = (c: HTMLElement) =>
    Array.from(c.querySelectorAll(".sync-lines li")).map((li) => li.textContent);

  test("shows each mapped environment as a line, and no counts before a plan is made", async () => {
    const w = await world({ mapping: { dev: "development", staging: "staging" } });
    mountPage(w.client);
    const c = await card();
    expect(strip(c)).toEqual(["dev \u2192 development", "staging \u2192 staging"]);
    expect(c.querySelector(".sync-flow")?.textContent).not.toContain("to create");
  });

  test("with a plan open, a line carries the counts of its own scope", async () => {
    const w = await filled({ mapping: { dev: "development", staging: "staging" } });
    mountPage(w.client);
    await planIt(userEvent.setup());
    const c = await card();
    // A_PLAIN and B_SECRET are new and D_CHANGED differs, all for every environment; F_DEV is dev's own
    expect(strip(c)).toEqual([
      "All environments2 to create, 1 to change",
      "dev \u2192 development1 to create",
      "staging \u2192 stagingNothing to change",
    ]);
  });

  test("a drifted target shows its totals once, on the Drift line, and not again in the flow", async () => {
    const w = await world();
    await recordDrift(
      backend.t.db,
      { id: w.target?.id ?? "", projectId: w.project.id, organizationId: w.org.id },
      "drifted",
      { create: 2, update: 1, delete: 0, noop: 3, adopt: 0 },
    );
    mountPage(w.client);
    const c = await card();
    await waitFor(() =>
      expect(facts(c).Drift).toContain("(2 to create, 1 to change, 0 to delete)"),
    );
    expect(c.textContent?.match(/to create/g)).toHaveLength(1);
  });
});

describe("a target that syncs by itself", () => {
  test("says so", async () => {
    const w = await world({ autoSync: true });
    mountPage(w.client);
    expect((await card()).textContent).toContain("Syncs by itself when a variable changes.");
  });
});

describe("what cannot be loaded", () => {
  test("a target list that fails says why and can be tried again", async () => {
    const w = await world();
    let failing = true;
    const client = clientVia(backend.api, w.cookie, async (request, send) =>
      failing && pathOf(request).endsWith("/sync-targets")
        ? down("the sync store is down")
        : send(),
    );
    mountPage(client);
    const user = userEvent.setup();
    expect((await screen.findByRole("alert")).textContent).toContain("the sync store is down");
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await card();
  });

  test("a target whose drift cannot be read says why and can be tried again", async () => {
    const w = await world();
    let failing = true;
    const client = clientVia(backend.api, w.cookie, async (request, send) =>
      failing && pathOf(request).endsWith("/drift") ? down("the drift store is down") : send(),
    );
    mountPage(client);
    const user = userEvent.setup();
    expect((await screen.findByRole("alert")).textContent).toContain("the drift store is down");
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await finished(/^Never synced/);
  });

  test("a last sync that cannot be read says why and can be tried again", async () => {
    const w = await world();
    let failing = true;
    const client = clientVia(backend.api, w.cookie, async (request, send) =>
      failing && pathOf(request).endsWith("/last-run") ? down("the run store is down") : send(),
    );
    mountPage(client);
    const user = userEvent.setup();
    expect((await screen.findByRole("alert")).textContent).toContain("the run store is down");
    failing = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await finished(/^Never synced/);
  });
});

describe("drift and the last sync", () => {
  const ref = (w: World) => {
    if (!w.target) throw new Error("no target");
    return { id: w.target.id, projectId: w.project.id, organizationId: w.org.id };
  };

  test("a drifted target shows what an apply would write, and when it was checked", async () => {
    const w = await world();
    await recordDrift(backend.t.db, ref(w), "drifted", {
      create: 2,
      update: 1,
      delete: 0,
      noop: 3,
      adopt: 0,
    });
    mountPage(w.client);
    const c = await card();
    await waitFor(() =>
      expect(facts(c).Drift).toMatch(/^Drifted checked \d{4}-\d\d-\d\d \d\d:\d\d UTC/),
    );
    expect(facts(c).Drift).toContain("(2 to create, 1 to change, 0 to delete)");
  });

  test("a target that is in sync says so, with no counts", async () => {
    const w = await world();
    await recordDrift(backend.t.db, ref(w), "in_sync", { noop: 4 });
    mountPage(w.client);
    const c = await card();
    await waitFor(() => expect(facts(c).Drift).toMatch(/^In sync checked /));
    expect(facts(c).Drift).not.toContain("to create");
  });
});

describe("a plan", () => {
  test("lists what would change by name, scope and field, shows no value, and writes nothing", async () => {
    const w = await filled();
    const { queries } = mountPage(w.client);
    const user = userEvent.setup();
    const p = await planIt(user);
    expect(p.textContent).toContain("Nothing has been changed on the target yet.");
    expect(p.textContent).toMatch(/good until \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
    expect(counts(p)).toEqual(["3 to create", "1 to change", "0 to delete"]);
    expect(rowsOf(within(p).getByRole("table"))).toEqual([
      ["A_PLAIN", "All environments", "Create", ""],
      ["B_SECRET", "All environments", "Create", ""],
      ["D_CHANGED", "All environments", "Change", "the value"],
      ["F_DEV", "development", "Create", ""],
    ]);
    expect(p.textContent).toContain("1 variable already matches.");
    // reading a plan changes nothing on the target, and no value reached the page or the cache
    expect(w.writes()).toBe(0);
    noValues();
    expect(
      JSON.stringify(
        queries
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);
    expect(await w.audit("sync_run.plan")).toHaveLength(1);
  });

  test("names what changed in a secret's settings, not its value", async () => {
    const w = await world();
    await w.put.project("MASKED_NOW", SECRET, true);
    await w.gitlab.variables.create(w.of, "MASKED_NOW", { value: SECRET, masked: false });
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    expect(rowsOf(within(p).getByRole("table"))).toEqual([
      ["MASKED_NOW", "All environments", "Change", "masked or not"],
    ]);
    noValues();
  });

  test("a target that already matches has nothing to apply", async () => {
    const w = await world();
    await w.put.project("SAME", "same-value");
    await w.gitlab.variables.create(w.of, "SAME", { value: "same-value" });
    mountPage(w.client);
    const user = userEvent.setup();
    const p = await planIt(user);
    expect(p.textContent).toContain(
      "The target already has everything this project would put there.",
    );
    expect(counts(p)).toEqual(["0 to create", "0 to change", "0 to delete"]);
    expect(within(p).queryByRole("table")).toBeNull();
    expect(within(p).queryByRole("button", { name: "Apply…" })).toBeNull();
    await user.click(within(p).getByRole("button", { name: "Discard plan" }));
    expect(await screen.findByRole("button", { name: "Plan sync" })).toBeTruthy();
  });

  test("a reference that cannot be resolved is left out and named", async () => {
    const w = await world();
    await w.put.project("GOOD", "good-value");
    await w.put.project("BROKEN", ref("NOPE_NOT_HERE"));
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    const left = within(p).getByRole("list");
    expect(left.textContent).toContain("BROKEN");
    expect(rowsOf(within(p).getByRole("table")).map((r) => r[0])).toEqual(["GOOD"]);
  });

  test("a value that grows past the limit is left out, and the reason is in words", async () => {
    const w = await world();
    await w.put.project("FINE", "fine-value");
    await w.put.project("BASE", "x".repeat(9_000));
    await w.put.project("HUGE", ref("BASE").repeat(130));
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    const left = within(p).getByRole("list");
    expect(left.textContent).toContain("HUGE");
    expect(left.textContent).toContain("too large");
    expect(left.textContent).not.toContain("_");
  });

  test("something only the target holds is listed and left alone, or deleted when the target says so", async () => {
    const w = await world({ policy: "prune" });
    await w.put.project("KEPT", "kept-value");
    await w.gitlab.variables.create(w.of, "G_EXTRA", { value: "not-wanted-value" });
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    expect(rowsOf(within(p).getByRole("table"))).toEqual([
      ["G_EXTRA", "All environments", "Delete from the target", ""],
      ["KEPT", "All environments", "Create", ""],
    ]);
    expect(counts(p)).toEqual(["1 to create", "0 to change", "1 to delete"]);
    expect(document.body.textContent).not.toContain("not-wanted-value");
  });

  test("a plan that only deletes can still be applied", async () => {
    const w = await world({ policy: "prune" });
    await w.gitlab.variables.create(w.of, "G_EXTRA", { value: "not-wanted-value" });
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    expect(rowsOf(within(p).getByRole("table"))).toEqual([
      ["G_EXTRA", "All environments", "Delete from the target", ""],
    ]);
    expect(within(p).getByRole("button", { name: "Apply\u2026" })).toBeTruthy();
  });

  test("an environment that is mapped and gone is said to be left alone", async () => {
    const w = await world();
    await w.put.project("A", "a-value");
    expect((await w.scope.environments({ envId: w.envs.dev ?? "" }).delete()).status).toBe(204);
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    expect(p.textContent).toMatch(/no longer exists, and left alone: .*dev/);
  });

  test("the counts are pills, each with a mark that is not read out and its words", async () => {
    const w = await filled();
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    const pills = Array.from(p.querySelectorAll(".sync-counts > .sync-count"));
    expect(pills.map((e) => e.textContent)).toEqual(["3 to create", "1 to change", "0 to delete"]);
    const marks = pills.map((e) => e.querySelector("svg.op"));
    expect(marks.map((m) => m?.getAttribute("aria-hidden"))).toEqual(["true", "true", "true"]);
    expect(
      marks.map((m) => Array.from(m?.classList ?? []).find((c) => c.startsWith("op-"))),
    ).toEqual(["op-create", "op-update", "op-delete"]);
  });

  test("a danger callout says what is deleted, and only when something is", async () => {
    const w = await world({ policy: "prune" });
    await w.put.project("KEPT", "kept-value");
    await w.gitlab.variables.create(w.of, "G_EXTRA", { value: "not-wanted-value" });
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    const danger = p.querySelector(".callout-bad");
    expect(danger?.getAttribute("role")).toBe("alert");
    expect(danger?.textContent).toContain("1 variable would be deleted from the target.");
    expect(danger?.textContent).toContain("cannot be brought back from here");
    expect(document.body.textContent).not.toContain("not-wanted-value");
  });

  test("the danger callout counts what is deleted, and says they, not it, for more than one", async () => {
    const w = await world({ policy: "prune" });
    await w.put.project("KEPT", "kept-value");
    await w.gitlab.variables.create(w.of, "G_EXTRA", { value: "not-wanted-value" });
    await w.gitlab.variables.create(w.of, "H_EXTRA", { value: "also-not-wanted" });
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    expect(p.querySelector(".callout-bad")?.textContent).toBe(
      "2 variables would be deleted from the target. This project does not hold their values, so they cannot be brought back from here.",
    );
  });

  test("a plan that deletes nothing has no danger callout, even where the target deletes what it holds alone", async () => {
    const w = await world({ policy: "prune" });
    await w.put.project("KEPT", "kept-value");
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    expect(counts(p)).toEqual(["1 to create", "0 to change", "0 to delete"]);
    expect(p.querySelector(".callout-bad")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("the plan the API refuses to make says why", async () => {
    const w = await world({ reporter: true });
    await w.put.project("A", "a-value");
    mountPage(w.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Plan sync" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/permission|allowed|forbidden/i);
    expect(screen.queryByRole("region", { name: "Plan for main" })).toBeNull();
    // the refusal leaves the button usable
    expect((screen.getByRole("button", { name: "Plan sync" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

describe("applying a plan", () => {
  test("asks first, and writes only after the plan has been read and confirmed", async () => {
    const w = await filled();
    const { queries } = mountPage(w.client);
    const user = userEvent.setup();
    const p = await planIt(user);
    await user.click(within(p).getByRole("button", { name: "Apply…" }));
    const dialog = screen.getByRole("dialog", { name: "Apply this plan to main?" });
    expect(dialog.textContent).toContain("creates 3, changes 1 and deletes 0 variables");
    // asking is not doing
    expect(w.writes()).toBe(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Apply this plan to main?" })).toBeNull();
    expect(w.writes()).toBe(0);

    await user.click(within(await plan()).getByRole("button", { name: "Apply…" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    await finished(/^Applied \d{4}-/);

    expect(await w.held()).toEqual({
      "A_PLAIN *": "plain-a-value",
      "B_SECRET *": SECRET,
      "D_CHANGED *": "d-new-value",
      "E_SAME *": "e-same-value",
      "F_DEV development": "f-dev-value",
    });
    // the plan is spent: the screen goes back to asking for one, and says what was done, still with no value
    expect(screen.queryByRole("region", { name: "Plan for main" })).toBeNull();
    expect(screen.getByRole("button", { name: "Plan sync" })).toBeTruthy();
    const { toggle, panel } = await disclosure();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    expect(
      rowsOf(within(panel() as HTMLElement).getByRole("table")).map((r) => [r[0], r[4]]),
    ).toEqual([
      ["A_PLAIN", "Done"],
      ["B_SECRET", "Done"],
      ["D_CHANGED", "Done"],
      ["F_DEV", "Done"],
    ]);
    noValues();
    expect(
      JSON.stringify(
        queries
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);
    expect(await w.audit("sync_run.apply")).toHaveLength(1);
  });

  test("what the last sync did is a button that opens and shuts it, and says which", async () => {
    const w = await filled();
    mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    await finished(/^Applied /);
    const { toggle, panel } = await disclosure();
    // nothing went wrong, so it is shut and its table is not on offer
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel()?.hidden).toBe(true);
    expect(within(panel() as HTMLElement).queryByRole("table")).toBeNull();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.hidden).toBe(false);
    expect(within(panel() as HTMLElement).getByRole("table")).toBeTruthy();
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(panel()?.hidden).toBe(true);
  });

  test("the last sync is still there after a reload of the page", async () => {
    const w = await filled();
    const first = mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    await finished(/^Applied /);
    first.unmount();
    mountPage(w.client);
    await card();
    await finished(/^Applied \d{4}-/);
  });

  test("shows that it is running, and cannot be planned over until it is done", async () => {
    const w = await filled();
    const release = pause();
    mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    await finished(/^Syncing now/);
    expect((screen.getByRole("button", { name: "Plan sync" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    release();
    await finished(/^Applied /);
    expect((screen.getByRole("button", { name: "Plan sync" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("an apply that is starting cannot be sent again or cancelled", async () => {
    const w = await filled();
    const gate = Promise.withResolvers<void>();
    let posts = 0;
    const client = clientVia(backend.api, w.cookie, async (request, send) => {
      if (pathOf(request).endsWith("/apply")) {
        posts += 1;
        await gate.promise;
      }
      return send();
    });
    mountPage(client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply\u2026" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    const starting = screen.getByRole("button", { name: "Starting\u2026" }) as HTMLButtonElement;
    expect(starting.disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(starting);
    gate.resolve();
    await finished(/^Applied /);
    expect(posts).toBe(1);
  });

  /** An apply started from elsewhere (another tab, a colleague): the screen learns of it when it looks again. */
  const startElsewhere = async (
    w: World,
    queries: { invalidateQueries: (f: object) => unknown },
  ) => {
    const at = w.scope["sync-targets"]({ targetId: w.target?.id ?? "" });
    must(await at.apply.post({ planId: must(await at.plan.post()).id }));
    await queries.invalidateQueries({ queryKey: ["sync-last"] });
    await finished(/^Syncing now/);
  };

  test("a plan on screen cannot be applied while another apply is running", async () => {
    const w = await filled();
    const { queries } = mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    const release = pause();
    await startElsewhere(w, queries);
    const apply = screen.getByRole("button", { name: "Apply\u2026" }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    release();
    await finished(/^Applied /);
    expect(apply.disabled).toBe(false);
  });

  test("a confirmation that is open cannot be sent once another apply is running", async () => {
    const w = await filled();
    const { queries } = mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply\u2026" }));
    const release = pause();
    await startElsewhere(w, queries);
    expect((screen.getByRole("button", { name: "Apply plan" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    release();
    await finished(/^Applied /);
  });

  test("the plan stays on screen until the last sync is known", async () => {
    const w = await filled();
    let hold: Promise<void> | undefined;
    let waiting = 0;
    const client = clientVia(backend.api, w.cookie, async (request, send) => {
      if (hold && pathOf(request).endsWith("/last-run")) {
        waiting += 1;
        await hold;
      }
      return send();
    });
    mountPage(client);
    const user = userEvent.setup();
    await planIt(user);
    const gate = Promise.withResolvers<void>();
    hold = gate.promise;
    await user.click(screen.getByRole("button", { name: "Apply\u2026" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    // the apply was accepted and the screen is asking what the last sync is: the plan is still there
    await waitFor(() => expect(waiting > 0).toBe(true));
    expect(screen.queryByRole("region", { name: "Plan for main" }) !== null).toBe(true);
    gate.resolve();
    await finished(/^Applied /);
  });

  test("a plan that is being made cannot be asked for again", async () => {
    const w = await filled();
    const gate = Promise.withResolvers<void>();
    let posts = 0;
    const client = clientVia(backend.api, w.cookie, async (request, send) => {
      if (pathOf(request).endsWith("/plan")) {
        posts += 1;
        await gate.promise;
      }
      return send();
    });
    mountPage(client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Plan sync" }));
    const planning = screen.getByRole("button", { name: "Planning\u2026" }) as HTMLButtonElement;
    expect(planning.disabled).toBe(true);
    await user.click(planning);
    gate.resolve();
    await plan();
    expect(posts).toBe(1);
  });

  test("the confirmation is a dialog that says what it will do, and Cancel gives the focus back", async () => {
    const w = await filled();
    mountPage(w.client);
    const user = userEvent.setup();
    const p = await planIt(user);
    const opener = within(p).getByRole("button", { name: "Apply…" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Apply this plan to main?" });
    // nothing is deleted, so it is not an alert, has no warning, and its answer is the plain one
    expect(dialog.getAttribute("role")).toBeNull();
    expect(dialog.querySelector(".callout")).toBeNull();
    // the noun follows the number of deletes, not the number of changes
    expect(dialog.textContent).toMatch(/and deletes 0 variables on the target\./);
    const answer = within(dialog).getByRole("button", { name: "Apply plan" });
    expect(answer.classList.contains("primary")).toBe(true);
    expect(answer.classList.contains("danger")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(opener);
  });

  test("a plan that deletes asks as an alert, with the warning in the dialog and a danger answer", async () => {
    const w = await world({ policy: "prune" });
    await w.put.project("KEPT", "kept-value");
    await w.gitlab.variables.create(w.of, "G_EXTRA", { value: "not-wanted-value" });
    mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Apply this plan to main?" });
    expect(dialog.textContent).toMatch(/and deletes 1 variable on the target\./);
    const warning = dialog.querySelector(".callout-warn");
    expect(warning?.textContent).toBe(
      "A variable deleted from the target cannot be brought back from here: this project does not hold its value.",
    );
    expect(warning?.getAttribute("role")).toBeNull();
    const answer = within(dialog).getByRole("button", { name: "Apply plan" });
    expect(answer.classList.contains("danger") && answer.classList.contains("solid")).toBe(true);
  });

  test("a started sync closes the dialog and is told by a toast", async () => {
    const w = await filled();
    mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    const told = await screen.findByText("Sync started on main.");
    expect(told.closest("[role=status]")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    await finished(/^Applied /);
  });

  test("an apply the server refuses is said in the dialog, which stays to try again", async () => {
    const w = await filled();
    let refusals = 2;
    const client = clientVia(backend.api, w.cookie, async (request, send) => {
      if (refusals > 0 && request.method === "POST" && pathOf(request).endsWith("/apply")) {
        refusals -= 1;
        return down("the apply store is down");
      }
      return send();
    });
    mountPage(client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    const dialog = screen.getByRole("dialog", { name: "Apply this plan to main?" });
    // the one alert on the page is in the dialog, where the person is looking
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBe(1);
    expect(dialog.contains(alerts[0] ?? null)).toBe(true);
    expect(alerts[0]?.textContent).toContain("the apply store is down");
    const again = within(dialog).getByRole("button", { name: "Apply plan" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    expect(w.writes()).toBe(0);
    // giving up and asking again does not show what went wrong the time before
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    expect((await screen.findByRole("alert")).textContent).toContain("the apply store is down");
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    await finished(/^Applied /);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("what would be deleted is said again before it is", async () => {
    const w = await world({ policy: "prune" });
    await w.put.project("KEPT", "kept-value");
    await w.gitlab.variables.create(w.of, "G_EXTRA", { value: "not-wanted-value" });
    mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    const dialog = screen.getByRole("alertdialog", { name: "Apply this plan to main?" });
    expect(dialog.textContent).toContain(
      "creates 1, changes 0 and deletes 1 variable on the target.",
    );
    expect(dialog.textContent).toContain("cannot be brought back from here");
    expect(Object.keys(await w.held())).toContain("G_EXTRA *");
    await user.click(within(dialog).getByRole("button", { name: "Apply plan" }));
    await finished(/^Applied /);
    expect(Object.keys(await w.held())).toEqual(["KEPT *"]);
  });

  test("a plan that the variables have moved on from is refused and has to be made again", async () => {
    const w = await filled();
    mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    await w.put.project("LATE", "late-value");
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    const refused = await screen.findByRole("alert");
    expect(refused.textContent).toContain("plan again");
    expect(refused.classList.contains("callout-bad")).toBe(true);
    // it can never be applied now, so it is gone, and nothing was written
    expect(screen.queryByRole("region", { name: "Plan for main" })).toBeNull();
    expect(w.writes()).toBe(0);
    const p = await planIt(user);
    expect(rowsOf(within(p).getByRole("table")).map((r) => r[0])).toContain("LATE");
    // a plan made again starts clean
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a line the target refuses is shown as failed, with why, and the others are done", async () => {
    const w = await filled();
    w.mock.inject({
      method: "POST",
      path: new RegExp(`/projects/${encodeURIComponent(w.of.project)}/variables`),
      status: 400,
      times: 1,
    });
    mountPage(w.client);
    const user = userEvent.setup();
    await planIt(user);
    await user.click(screen.getByRole("button", { name: "Apply…" }));
    await user.click(screen.getByRole("button", { name: "Apply plan" }));
    await finished(/^Failed /);
    expect(facts(document.body)["Last sync"]).toContain(
      "1 of 4 changes failed (1 variable failed)",
    );
    // what went wrong is open without asking for it, and holds no value
    const { toggle, panel } = await disclosure();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const results = rowsOf(within(panel() as HTMLElement).getByRole("table")).map((r) => r[4]);
    expect(results.filter((r) => r?.startsWith("Failed: "))).toHaveLength(1);
    expect(results.filter((r) => r === "Done")).toHaveLength(3);
    noValues();
  });
});

describe("how the screen looks", () => {
  test("drift is a badge with its words, and Plan sync sits in the card's head", async () => {
    const w = await world();
    if (!w.target) throw new Error("no target");
    await recordDrift(
      backend.t.db,
      { id: w.target.id, projectId: w.project.id, organizationId: w.org.id },
      "drifted",
      { create: 1, update: 0, delete: 0 },
    );
    mountPage(w.client);
    const c = await card();
    await waitFor(() => expect(facts(c).Drift).toMatch(/^Drifted /));
    const badge = c.querySelector("dd .st");
    expect([badge?.className, badge?.textContent]).toEqual(["st st-warn", "Drifted"]);
    expect(
      within(c).getByRole("button", { name: "Plan sync" }).closest(".card-head"),
    ).not.toBeNull();
  });

  test("each kind of change in a plan has its own mark, which is not read out", async () => {
    const w = await filled();
    mountPage(w.client);
    const p = await planIt(userEvent.setup());
    const mark = (action: string) =>
      Array.from(within(p).getByRole("table").querySelectorAll("tbody tr"))
        .find((tr) => tr.children[2]?.textContent === action)
        ?.querySelector("svg.op");
    const create = mark("Create");
    const change = mark("Change");
    expect(create?.getAttribute("aria-hidden")).toBe("true");
    expect(change?.getAttribute("aria-hidden")).toBe("true");
    expect(create?.innerHTML).not.toBe(change?.innerHTML);
    expect(create?.classList.contains("op-create")).toBe(true);
    expect(change?.classList.contains("op-update")).toBe(true);
  });
});
