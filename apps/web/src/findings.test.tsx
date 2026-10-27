import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { listFindings, secretFindings, upsertFindings } from "@orch/db";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eq } from "drizzle-orm";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { Toaster } from "./components";
import { FindingsPage } from "./findings";
import { OrgProvider, RequireOrg } from "./org";
import { type Backend, clientVia, mount, pathOf, startBackend, visibleText } from "./testing";
import { must, scene as sceneOn } from "./variables.fixture";

let backend: Backend;
beforeAll(async () => {
  backend = await startBackend();
});
afterAll(() => backend.stop());
beforeEach(() => {
  window.location.hash = "#/findings";
});

type Scene = Awaited<ReturnType<typeof sceneOn>>;

/** What a planted secret looks like: nothing of it is a field of a finding, so it must never be on screen. */
const SECRET = "AKIAIOSFODNN7CANARY0";
const finding = (fingerprint: string, over: object = {}) => ({
  fingerprint,
  rule: "aws-access-token",
  path: "src/config.ts",
  line: 7,
  commit: "a1b2c3d4e5f6",
  severity: "critical" as const,
  ...over,
});
const seed = (s: Scene, findings: ReturnType<typeof finding>[], ref = "main") =>
  upsertFindings(backend.t.db, {
    organizationId: s.org.id,
    projectId: s.project.id,
    ref,
    findings,
  });
const stored = (s: Scene) => listFindings(backend.t.db, s.org.id, s.project.id, { limit: 100 });

function mountPage(client: ReturnType<Backend["anonymous"]>) {
  render(
    <Providers client={client} queries={newQueryClient()}>
      <Toaster>
        <AuthGate>
          <OrgProvider>
            <RequireOrg>{(org) => <FindingsPage orgId={org.id} />}</RequireOrg>
          </OrgProvider>
        </AuthGate>
      </Toaster>
    </Providers>,
  );
}

const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? undefined;
// a result is a toast, and the region it is read from is there before it
const toastText = () => document.querySelector(".toast-text")?.textContent ?? "";
// a role query is slow in happy-dom, and a slow one inside a wait starves the refresh it waits for
const rowHeaders = () =>
  Array.from(document.querySelectorAll('th[scope="row"]')).map((h) => h.textContent);
const table = () => screen.findByRole("table", { name: "Secret findings" });
// a path breaks after a slash at a <wbr>, where happy-dom puts a space into the accessible name and a browser does not
// (the e2e asks a browser): the name is the path all the same
const named = (where: string) => (name: string) => name.replaceAll(" ", "") === where;
const rowOf = (t: HTMLElement, where: string) => {
  const tr = within(t)
    .getByRole("rowheader", { name: named(where) })
    .closest("tr");
  if (!tr) throw new Error(`no row for ${where}`);
  return tr;
};
const CHIP: Record<string, string> = {
  open: "Open",
  dismissed: "Dismissed",
  resolved: "Resolved",
  all: "All",
};
const show = (status: string) =>
  userEvent.setup().click(screen.getByRole("button", { name: CHIP[status] }));
const NOTICE = /revoke it at the source/i;

describe("the page", () => {
  test("is in the navigation, and says so when there are no findings", async () => {
    const s = await sceneOn(backend);
    mount(s.client);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Findings" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Findings");
    await screen.findByText("No open findings");
    screen.getByText("Nothing in this project needs revoking right now.");
    expect(screen.queryByRole("table")).toBeNull();
    // nothing to revoke, nothing to be told
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  test("the lists are chips: found by name, the shown one pressed, and no select is left", async () => {
    const s = await sceneOn(backend);
    await seed(s, [finding("f1")]);
    mountPage(s.client);
    await table();
    const group = screen.getByRole("group", { name: "Show findings" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["Open", "Dismissed", "Resolved", "All"]);
    const pressed = () => chips.filter((c) => c.getAttribute("aria-pressed") === "true");
    expect(pressed().map((c) => c.textContent)).toEqual(["Open"]);
    expect(screen.queryByRole("combobox", { name: "Show" })).toBeNull();
    await show("dismissed");
    expect(pressed().map((c) => c.textContent)).toEqual(["Dismissed"]);
    // the chip keeps the focus through the new list loading, and the card says how many it shows
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Dismissed" }));
    await screen.findByText("No dismissed findings");
    screen.getByText("A finding you dismiss is listed here with who dismissed it and why.");
    await show("resolved");
    await screen.findByText("No resolved findings");
    await show("all");
    await table();
    screen.getByText(/^1 finding in /);
  });

  test("a long path may break after any slash, and its text is the same", async () => {
    const s = await sceneOn(backend);
    const deep = "services/billing/deploy/overlays/production/secrets.generated.yaml";
    await seed(s, [finding("f1", { path: deep, line: 17 })]);
    mountPage(s.client);
    const header = within(await table()).getByRole("rowheader");
    expect(header.textContent).toBe(`${deep}:17`);
    // a break point after each of the five slashes, none in the name itself
    expect(header.querySelectorAll("wbr")).toHaveLength(5);
    expect(header.querySelector("code")?.firstChild?.textContent).toBe("services/");
    expect(
      within(header.closest("table") as HTMLElement).getByRole("rowheader", {
        name: named(`${deep}:17`),
      }),
    ).toBe(header);
  });

  test("lists the open findings with where each is, and says to revoke at the source", async () => {
    const s = await sceneOn(backend);
    await seed(s, [
      finding("f1"),
      finding("f2", { rule: "gitlab-pat", path: "ci/deploy.sh", line: null, severity: "high" }),
      finding("f3", { path: "old.ts" }),
    ]);
    await seed(s, [finding("f4", { path: "feature.ts" })], "feature/x");
    mountPage(s.client);
    const t = await table();
    expect(
      within(t)
        .getAllByRole("rowheader")
        .map((h) => h.textContent)
        .sort(),
    ).toEqual(["ci/deploy.sh", "feature.ts:7", "old.ts:7", "src/config.ts:7"]);
    const cells = (where: string) =>
      Array.from(rowOf(t, where).querySelectorAll("td")).map((td) => td.textContent);
    expect(cells("src/config.ts:7").slice(0, 4)).toEqual([
      "aws-access-token",
      "Critical",
      "main",
      "Open",
    ]);
    expect(cells("ci/deploy.sh").slice(0, 4)).toEqual(["gitlab-pat", "High", "main", "Open"]);
    expect(cells("feature.ts:7")[2]).toBe("feature/x");
    const notice = screen.getByText(NOTICE);
    expect(notice.textContent).toMatch(/dismiss/i);
    expect(notice.textContent).toMatch(/does not make it safe|only stops it being counted/i);
    // what the scanner saw is not a field of a finding, so it is nowhere on the page
    expect(document.body.textContent).not.toContain(SECRET);
  });

  test("another project's findings are not here", async () => {
    const s = await sceneOn(backend);
    const other = await sceneOn(backend);
    await seed(other, [finding("x1", { path: "theirs.ts" })]);
    await seed(s, [finding("f1", { path: "ours.ts" })]);
    mountPage(s.client);
    const t = await table();
    expect(within(t).queryByRole("rowheader", { name: named("theirs.ts:7") })).toBeNull();
    within(t).getByRole("rowheader", { name: named("ours.ts:7") });
  });

  test("a dismissed finding is under Dismissed, with who and why; resolved ones have their own view", async () => {
    const s = await sceneOn(backend);
    await seed(s, [
      finding("f1"),
      finding("f2", { path: "gone.ts" }),
      finding("f3", { path: "b.ts" }),
    ]);
    const rows = await stored(s);
    const id = (path: string) => rows.find((r) => r.path === path)?.id ?? "";
    must(
      await s.scope.findings({ findingId: id("src/config.ts") }).dismiss.post({
        reason: "Rotated in AWS, the key is dead",
      }),
    );
    // what a default-branch scan that no longer has it does
    await backend.t.db
      .update(secretFindings)
      .set({ status: "resolved" })
      .where(eq(secretFindings.id, id("gone.ts")));
    mountPage(s.client);
    await table();
    await show("dismissed");
    const t = await table();
    await waitFor(() => expect(rowHeaders()).not.toContain("b.ts:7"), { timeout: 5000 });
    const row = rowOf(t, "src/config.ts:7");
    expect(row.textContent).toContain("Dismissed");
    expect(row.textContent).toContain("Rotated in AWS, the key is dead");
    expect(row.textContent).toMatch(/by user:/);
    expect(within(row).getByRole("button", { name: "Reopen src/config.ts:7" })).toBeDefined();
    expect(within(row).queryByRole("button", { name: /^Dismiss/ })).toBeNull();

    await show("resolved");
    await waitFor(() => expect(rowHeaders()).toEqual(["gone.ts:7"]), { timeout: 5000 });
    // a resolved finding has nothing to triage
    expect(within(rowOf(await table(), "gone.ts:7")).queryAllByRole("button")).toEqual([]);

    await show("all");
    await waitFor(() => expect(rowHeaders()).toHaveLength(3), { timeout: 5000 });
  });
});

describe("dismissing", () => {
  test("needs a reason, then takes the finding off the open list and says it is still to be revoked", async () => {
    const s = await sceneOn(backend);
    await seed(s, [finding("f1"), finding("f2", { path: "keep.ts" })]);
    mountPage(s.client);
    const user = userEvent.setup();
    const t = await table();
    // one word on the page; the whole name stays for assistive technology
    const dismiss = within(t).getByRole("button", { name: "Dismiss src/config.ts:7" });
    expect(visibleText(dismiss)).toBe("Dismiss");
    await user.click(dismiss);
    // a question with one field is a dialog, which says which finding and that the secret stays valid
    const dialog = screen.getByRole("dialog", { name: "Dismiss this finding" });
    expect(dialog.textContent).toContain("src/config.ts:7 matched aws-access-token on main.");
    expect(dialog.textContent).toContain(
      "The secret is still valid until it is revoked at its source.",
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Reason"));
    const submit = within(dialog).getByRole("button", {
      name: "Dismiss finding",
    }) as HTMLButtonElement;
    // no reason, or a blank one, is not enough
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText("Reason"), "   ");
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText("Reason"), "Revoked at the cloud account");
    expect(submit.disabled).toBe(false);
    await user.click(submit);

    await waitFor(() => expect(toastText()).toContain("Dismissed src/config.ts:7"));
    expect(toastText()).toMatch(/still valid|revoked at its source/i);
    expect(document.querySelector(".toast-text")?.getAttribute("role")).toBe("status");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(rowHeaders()).not.toContain("src/config.ts:7"), { timeout: 5000 });
    screen.getByRole("rowheader", { name: named("keep.ts:7") });
    const rows = await stored(s);
    expect(rows.find((r) => r.path === "src/config.ts")).toMatchObject({
      status: "dismissed",
      dismissedReason: "Revoked at the cloud account",
    });
    expect(await s.audit("finding.dismiss")).toHaveLength(1);
  });

  test("Cancel closes the form and changes nothing", async () => {
    const s = await sceneOn(backend);
    await seed(s, [finding("f1")]);
    mountPage(s.client);
    const user = userEvent.setup();
    await user.click(
      within(await table()).getByRole("button", { name: "Dismiss src/config.ts:7" }),
    );
    await user.type(screen.getByLabelText("Reason"), "typed and thought better of it");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Reason")).toBeNull();
    expect((await stored(s))[0]?.status).toBe("open");
    expect(await s.audit("finding.dismiss")).toHaveLength(0);
  });

  test("Esc closes the dialog and the focus goes back to the button that opened it", async () => {
    const s = await sceneOn(backend);
    await seed(s, [finding("f1")]);
    mountPage(s.client);
    const user = userEvent.setup();
    const opener = within(await table()).getByRole("button", { name: "Dismiss src/config.ts:7" });
    await user.click(opener);
    screen.getByRole("dialog", { name: "Dismiss this finding" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(await s.audit("finding.dismiss")).toHaveLength(0);
  });

  test("a reporter may see findings, and is told by the API when a dismissal is not theirs to make", async () => {
    const s = await sceneOn(backend, { reporter: true });
    await seed(s, [finding("f1")]);
    mountPage(s.client);
    const user = userEvent.setup();
    await user.click(
      within(await table()).getByRole("button", { name: "Dismiss src/config.ts:7" }),
    );
    await user.type(screen.getByLabelText("Reason"), "not mine to say");
    await user.click(screen.getByRole("button", { name: "Dismiss finding" }));
    await waitFor(() => expect(alertText()).toBeTruthy());
    // the answer is in the dialog, which stays for another try; the finding is still on the list, still open
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeDefined();
    screen.getByRole("rowheader", { name: named("src/config.ts:7") });
    expect((await stored(s))[0]?.status).toBe("open");
    expect(await s.audit("finding.dismiss")).toHaveLength(0);
  });

  test("Cancel after a refused dismissal does not move its error onto the page", async () => {
    const s = await sceneOn(backend, { reporter: true });
    await seed(s, [finding("f1")]);
    mountPage(s.client);
    const user = userEvent.setup();
    await user.click(
      within(await table()).getByRole("button", { name: "Dismiss src/config.ts:7" }),
    );
    await user.type(screen.getByLabelText("Reason"), "not mine to say");
    await user.click(screen.getByRole("button", { name: "Dismiss finding" }));
    await waitFor(() => expect(alertText()).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    // booleans: a failed toBeNull on a big element takes a minute to print in happy-dom
    await waitFor(() => expect(screen.queryByLabelText("Reason") === null).toBe(true));
    expect(alertText() === undefined).toBe(true);
  });

  test("one that was dismissed meanwhile is reported, and the list catches up", async () => {
    const s = await sceneOn(backend);
    await seed(s, [finding("f1")]);
    mountPage(s.client);
    const user = userEvent.setup();
    const t = await table();
    await user.click(within(t).getByRole("button", { name: "Dismiss src/config.ts:7" }));
    await user.type(screen.getByLabelText("Reason"), "me");
    // someone else got there first
    const [row] = await stored(s);
    must(await s.scope.findings({ findingId: row?.id ?? "" }).dismiss.post({ reason: "them" }));
    await user.click(screen.getByRole("button", { name: "Dismiss finding" }));
    await waitFor(() => expect(alertText()).toContain("already dismissed"));
    await waitFor(() => expect(rowHeaders()).not.toContain("src/config.ts:7"), { timeout: 5000 });
    // the dialog still says which finding it was about, though the list no longer has it
    expect(screen.getByRole("dialog", { name: "Dismiss this finding" }).textContent).toContain(
      "src/config.ts:7",
    );
  });
});

describe("reopening", () => {
  test("puts a dismissed finding back on the open list", async () => {
    const s = await sceneOn(backend);
    await seed(s, [finding("f1")]);
    const [row] = await stored(s);
    must(await s.scope.findings({ findingId: row?.id ?? "" }).dismiss.post({ reason: "wrongly" }));
    mountPage(s.client);
    const user = userEvent.setup();
    await screen.findByText("No open findings");
    await show("dismissed");
    await user.click(await screen.findByRole("button", { name: "Reopen src/config.ts:7" }));
    await waitFor(() => expect(toastText()).toBe("Reopened src/config.ts:7."));
    await waitFor(() => expect(rowHeaders()).not.toContain("src/config.ts:7"), { timeout: 5000 });
    expect((await stored(s))[0]).toMatchObject({ status: "open", dismissedReason: null });
    expect(await s.audit("finding.reopen")).toHaveLength(1);
  });
});

describe("when the API does not answer", () => {
  test("the list failing is shown with a way to try again", async () => {
    const s = await sceneOn(backend);
    await seed(s, [finding("f1")]);
    let failing = true;
    mountPage(
      clientVia(backend.api, s.cookie, async (request, send) =>
        failing && pathOf(request).endsWith("/findings")
          ? Response.json(
              { type: "x", title: "Oops", status: 500, code: "internal", detail: "Try later." },
              { status: 500 },
            )
          : send(),
      ),
    );
    await waitFor(() => expect(alertText()).toContain("Try later."));
    failing = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    await table();
    expect(alertText()).toBeUndefined();
  });
});

describe("how the screen looks", () => {
  /** The badge in a cell: its classes, and whether its shape is kept from assistive technology. */
  const badge = (tr: HTMLElement, cell: number) => {
    const el = tr.querySelectorAll("td")[cell]?.querySelector(".st");
    return [el?.className, el?.querySelector("svg")?.getAttribute("aria-hidden")];
  };

  test("severity and status are badges, and the list is in a card", async () => {
    const s = await sceneOn(backend);
    await seed(s, [
      finding("f1"),
      finding("f2", { path: "hi.ts", severity: "high" }),
      finding("f3", { path: "med.ts", severity: "medium" }),
      finding("f4", { path: "low.ts", severity: "low" }),
    ]);
    mountPage(s.client);
    const t = await table();
    expect(within(screen.getByRole("region", { name: "Findings" })).getByRole("table")).toBe(t);
    // a table of this width needs the whole page, not the narrow form column
    expect(t.closest(".stack")?.classList.contains("wide")).toBe(true);
    const tone = (where: string) => badge(rowOf(t, where), 1);
    expect(tone("src/config.ts:7")).toEqual(["st st-bad", "true"]);
    expect(tone("hi.ts:7")).toEqual(["st st-bad", "true"]);
    expect(tone("med.ts:7")).toEqual(["st st-warn", "true"]);
    expect(tone("low.ts:7")).toEqual(["st st-quiet", "true"]);
    // an open finding is waiting for someone, not a failure
    expect(badge(rowOf(t, "low.ts:7"), 3)).toEqual(["st st-manual", "true"]);
  });

  test("a dismissed finding is quiet and a resolved one is ok", async () => {
    const s = await sceneOn(backend);
    // one stays open, so the page opens on a table
    await seed(s, [
      finding("f1"),
      finding("f2", { path: "gone.ts" }),
      finding("f3", { path: "b.ts" }),
    ]);
    const rows = await stored(s);
    const id = (path: string) => rows.find((r) => r.path === path)?.id ?? "";
    must(
      await s.scope
        .findings({ findingId: id("src/config.ts") })
        .dismiss.post({ reason: "Dead key" }),
    );
    await backend.t.db
      .update(secretFindings)
      .set({ status: "resolved" })
      .where(eq(secretFindings.id, id("gone.ts")));
    mountPage(s.client);
    await table();
    await show("all");
    await waitFor(() => expect(rowHeaders()).toHaveLength(3), { timeout: 5000 });
    const t = await table();
    expect(badge(rowOf(t, "src/config.ts:7"), 3)).toEqual(["st st-quiet", "true"]);
    expect(badge(rowOf(t, "gone.ts:7"), 3)).toEqual(["st st-ok", "true"]);
  });
});
