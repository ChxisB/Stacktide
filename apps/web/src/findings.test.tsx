import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { listFindings, secretFindings, upsertFindings } from "@orch/db";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { eq } from "drizzle-orm";
import { newQueryClient, Providers } from "./app";
import { AuthGate } from "./auth";
import { FindingsPage } from "./findings";
import { OrgProvider, RequireOrg } from "./org";
import { type Backend, clientVia, mount, pathOf, startBackend } from "./testing";
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
      <AuthGate>
        <OrgProvider>
          <RequireOrg>{(org) => <FindingsPage orgId={org.id} />}</RequireOrg>
        </OrgProvider>
      </AuthGate>
    </Providers>,
  );
}

const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? undefined;
const statusText = () => document.querySelector('[role="status"]')?.textContent ?? undefined;
// a role query is slow in happy-dom, and a slow one inside a wait starves the refresh it waits for
const rowHeaders = () =>
  Array.from(document.querySelectorAll('th[scope="row"]')).map((h) => h.textContent);
const table = () => screen.findByRole("table", { name: "Secret findings" });
const rowOf = (t: HTMLElement, where: string) => {
  const tr = within(t).getByRole("rowheader", { name: where }).closest("tr");
  if (!tr) throw new Error(`no row for ${where}`);
  return tr;
};
const show = (status: string) =>
  userEvent.setup().selectOptions(screen.getByLabelText("Show"), status);
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
    await screen.findByText(/No open findings for this project/);
    expect(screen.queryByRole("table")).toBeNull();
    // nothing to revoke, nothing to be told
    expect(screen.queryByText(NOTICE)).toBeNull();
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
    expect(within(t).queryByRole("rowheader", { name: "theirs.ts:7" })).toBeNull();
    within(t).getByRole("rowheader", { name: "ours.ts:7" });
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
    await user.click(within(t).getByRole("button", { name: "Dismiss src/config.ts:7" }));
    const submit = screen.getByRole("button", { name: "Dismiss finding" }) as HTMLButtonElement;
    // no reason, or a blank one, is not enough
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText("Reason"), "   ");
    expect(submit.disabled).toBe(true);
    await user.type(screen.getByLabelText("Reason"), "Revoked at the cloud account");
    expect(submit.disabled).toBe(false);
    await user.click(submit);

    await waitFor(() => expect(statusText()).toContain("Dismissed src/config.ts:7"));
    expect(statusText()).toMatch(/still valid|revoked at its source/i);
    await waitFor(() => expect(rowHeaders()).not.toContain("src/config.ts:7"), { timeout: 5000 });
    screen.getByRole("rowheader", { name: "keep.ts:7" });
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
    // the finding is still on the list, still open
    screen.getByRole("rowheader", { name: "src/config.ts:7" });
    expect((await stored(s))[0]?.status).toBe("open");
    expect(await s.audit("finding.dismiss")).toHaveLength(0);
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
    await screen.findByText(/No open findings for this project/);
    await show("dismissed");
    await user.click(await screen.findByRole("button", { name: "Reopen src/config.ts:7" }));
    await waitFor(() => expect(statusText()).toContain("Reopened src/config.ts:7"));
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
