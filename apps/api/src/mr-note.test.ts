import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CostLimit } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import type { RunStack } from "@orch/db";
import {
  createConnection,
  createOrganization,
  createProject,
  createRun,
  setCostLimit,
  setSecretGate,
  storePlanSummary,
  upsertFindings,
  withMergeRequest,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { inline, refreshNote, renderNote, writeNote } from "./mr-note";
import type { SecretGateView } from "./secret-gate";

const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const stack = (over: Partial<RunStack> = {}): RunStack => ({
  runId: "r",
  organizationId: "o",
  projectId: "p",
  stack: "net",
  tags: [],
  status: "queued",
  error: null,
  planJobId: null,
  summaryJobId: null,
  planAdd: null,
  planChange: null,
  planDestroy: null,
  summarizedAt: null,
  costMonthlyDelta: null,
  costMonthlyTotal: null,
  costCurrency: null,
  costTool: null,
  policyVerdict: null,
  policyDenied: null,
  policyWarned: null,
  policyAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});
const URL = "https://gitlab.example.com/g/iac";

describe("what the policy said, in the note", () => {
  const judged = (over: Partial<RunStack>) => stack({ status: "planned", ...over });
  const note = (stacks: RunStack[]) =>
    renderNote({ run: { sha: SHA, stacks }, notice: null, projectUrl: undefined });

  test("is a line per judged stack: the verdict and the names of the rules that fired", () => {
    const body = note([
      judged({ stack: "net", policyVerdict: "pass", policyDenied: [], policyWarned: [] }),
      judged({
        stack: "app",
        policyVerdict: "deny",
        policyDenied: ["data.main.deny_public"],
        policyWarned: ["data.main.warn_tags"],
      }),
      judged({ stack: "db", policyVerdict: "warn", policyDenied: [], policyWarned: ["w1"] }),
      stack({ stack: "queue" }),
    ]);
    expect(body).toContain("Policy:");
    expect(body).toContain("- `net`: pass\n");
    expect(body).toContain("- `app`: deny (`data.main.deny_public`, `data.main.warn_tags`)");
    expect(body).toContain("- `db`: warn (`w1`)");
    // a stack nothing has judged has no line
    expect(body).not.toContain("- `queue`");
  });

  test("is left out when no stack has been judged", () => {
    expect(note([stack({ stack: "net" })])).not.toContain("Policy");
  });

  test("shows three names at most, and cannot be turned into markdown", () => {
    const names = ["a", "b", "c", "d", "e"].map((n) => `rule.${n}`);
    const body = note([
      judged({ stack: "net", policyVerdict: "deny", policyDenied: names, policyWarned: [] }),
      // not a name the route would store, but the note does not trust the row for its markup
      judged({
        stack: "app",
        policyVerdict: "deny",
        policyDenied: ["x`](http://evil.example)\n# heading"],
        policyWarned: [],
      }),
    ]);
    expect(body).toContain("- `net`: deny (`rule.a`, `rule.b`, `rule.c`, and 2 more)");
    expect(body).not.toContain("rule.d");
    const line = body.split("\n").find((l) => l.startsWith("- `app`")) ?? "";
    expect(line.split("`").length).toBe(5); // `app` and one code span: no span was ended early
    expect(body).not.toContain("\n# heading");
  });
});

describe("what the plan costs, in the note", () => {
  const LIMIT: CostLimit = { tag: null, maxMonthlyDelta: 100, warnAt: 80, currency: "USD" };
  const planned = (stackName: string, delta: number | null, over: Partial<RunStack> = {}) =>
    stack({
      stack: stackName,
      status: "planned",
      planAdd: 1,
      planChange: 0,
      planDestroy: 0,
      summarizedAt: new Date(0),
      ...(delta === null
        ? {}
        : {
            costMonthlyDelta: delta,
            costMonthlyTotal: 1234.5,
            costCurrency: "USD",
            costTool: "infracost",
          }),
      ...over,
    });
  const note = (stacks: RunStack[], limits: CostLimit[] = [LIMIT]) =>
    renderNote({ run: { sha: SHA, stacks }, notice: null, projectUrl: undefined, limits });

  test("is a line per stack with an estimate or a limit: the figures, labelled as an estimate, and what the limit makes of them", () => {
    const body = note([
      planned("a-pass", 42),
      planned("b-warn", 85),
      planned("c-deny", 250.5),
      planned("d-unavailable", null),
      planned("e-saving", -10.25),
    ]);
    expect(body).toContain("Cost (estimate):");
    expect(body).toContain(
      "- `a-pass`: +42.00 USD a month, total 1234.50 USD (estimate by `infracost`); limit 100.00 USD: pass\n",
    );
    expect(body).toContain(
      "- `b-warn`: +85.00 USD a month, total 1234.50 USD (estimate by `infracost`); limit 100.00 USD: warn (`cost-near-limit`)",
    );
    expect(body).toContain(
      "- `c-deny`: +250.50 USD a month, total 1234.50 USD (estimate by `infracost`); limit 100.00 USD: deny (`cost-over-limit`)",
    );
    expect(body).toContain(
      "- `d-unavailable`: no estimate; limit 100.00 USD: deny (`cost-unavailable`)",
    );
    expect(body).toContain("- `e-saving`: -10.25 USD a month,");
    expect(body).toMatchSnapshot();
  });

  test("an estimate with no limit is shown and says there is none; with neither, or not planned yet, there is no line", () => {
    const body = note([planned("net", 42), planned("db", null), stack({ stack: "queued" })], []);
    expect(body).toContain(
      "- `net`: +42.00 USD a month, total 1234.50 USD (estimate by `infracost`); no limit\n",
    );
    expect(body).not.toContain("- `db`");
    expect(body).not.toContain("- `queued`");
    // a limit and a stack nothing has summarized: the estimator may still run, so no "unavailable" yet
    expect(note([stack({ stack: "queued" })])).not.toContain("Cost");
    expect(note([planned("db", null)], [])).not.toContain("Cost");
  });

  test("shows the precision a comparison turned on: an amount just over the limit is not rounded down to it", () => {
    const body = note(
      [planned("over", 100.004), planned("under", 79.996), planned("whole", 5)],
      [{ ...LIMIT, warnAt: 80 }],
    );
    expect(body).toContain("- `over`: +100.004 USD a month");
    expect(body).toContain("limit 100.00 USD: deny (`cost-over-limit`)");
    expect(body).toContain("- `under`: +79.996 USD a month");
    expect(body).toContain("- `whole`: +5.00 USD a month");
  });

  test("a currency that is not the limit's is named, not converted", () => {
    const body = note([planned("net", 42, { costCurrency: "EUR" })]);
    expect(body).toContain("+42.00 EUR a month");
    expect(body).toContain("limit 100.00 USD: deny (`cost-currency-mismatch`)");
  });

  test("uses the limit of the stack's own tag", () => {
    const limits = [LIMIT, { ...LIMIT, tag: "prod", maxMonthlyDelta: 30, warnAt: null }];
    const body = note([planned("net", 42, { tags: ["prod"] }), planned("app", 42)], limits);
    expect(body).toContain(
      "- `net`: +42.00 USD a month, total 1234.50 USD (estimate by `infracost`); limit 30.00 USD: deny",
    );
    expect(body).toContain(
      "- `app`: +42.00 USD a month, total 1234.50 USD (estimate by `infracost`); limit 100.00 USD: pass",
    );
  });

  test("shows no figure that is not a number and cannot be turned into markdown, whatever the row holds", () => {
    const body = note([
      planned("net", 1, { costTool: "x`](http://evil.example)\n# heading", costCurrency: "U|S" }),
    ]);
    const line = body.split("\n").find((l) => l.startsWith("- `net`")) ?? "";
    // the tool's text is inside a code span, where GitLab makes no link of it; outside the spans there is none
    expect(line.replace(/`[^`]*`/g, "")).not.toMatch(/http|\]\(/);
    // three spans: the stack, the tool and the one rule it broke (a currency that is not the limit's)
    expect(line.split("`")).toHaveLength(7);
    expect(body.split("\n").some((l) => l.startsWith("#"))).toBe(false);
  });
});

describe("what the secret gate says, in the note (SCAN-6)", () => {
  const view = (gate: SecretGateView["gate"], open: number): SecretGateView => ({
    gate,
    open,
    denied: gate === "deny" && open > 0 ? ["secret-findings-open"] : [],
    warned: gate === "warn" && open > 0 ? ["secret-findings-open"] : [],
  });
  const note = (secrets?: SecretGateView) =>
    renderNote({
      run: { sha: SHA, stacks: [stack()] },
      notice: null,
      projectUrl: undefined,
      secrets,
    });

  test.each([
    ["off", 0],
    ["off", 3],
    ["warn", 0],
    ["deny", 0],
  ] as const)("says nothing for %s with %d open", (gate, open) => {
    expect(note(view(gate, open))).not.toContain("secret");
    expect(note(view(gate, open))).toBe(note());
  });

  test("a warn names the count and the rule; a deny says applies are held", () => {
    expect(note(view("warn", 2))).toContain(
      "Secrets: 2 open findings on the default branch (`secret-findings-open`, warn). Revoke them at the source.",
    );
    expect(note(view("deny", 1))).toContain(
      "Secrets: 1 open finding on the default branch (`secret-findings-open`, deny). Applies are held until they are revoked at the source and dismissed.",
    );
  });
});

describe("the note's text", () => {
  test("is a table with a row per stack: state, counts and a link to the plan job", () => {
    const body = renderNote({
      run: {
        sha: SHA,
        stacks: [
          stack({
            stack: "app",
            status: "planned",
            planAdd: 2,
            planChange: 1,
            planDestroy: 0,
            planJobId: 42,
          }),
          stack({ stack: "net", status: "failed", error: "the plan failed", planJobId: 41 }),
          stack({ stack: "db" }),
        ],
      },
      notice: null,
      projectUrl: URL,
    });
    expect(body).toContain(`Commit \`${SHA}\``);
    expect(body).toContain(`| \`app\` | planned | 2 | 1 | 0 | [job](${URL}/-/jobs/42) |`);
    expect(body).toContain(
      `| \`net\` | failed (the plan failed) | – | – | – | [job](${URL}/-/jobs/41) |`,
    );
    expect(body).toContain("| `db` | queued | – | – | – | – |");
  });

  test("shows no address of a resource, whatever the row holds", () => {
    const row = Object.assign(
      stack({ status: "planned", planAdd: 1, planChange: 0, planDestroy: 0 }),
      {
        planResources: [{ address: "aws_iam_access_key.deploy", actions: ["create"] }],
      },
    );
    const body = renderNote({ run: { sha: SHA, stacks: [row] }, notice: null, projectUrl: URL });
    expect(body).not.toContain("aws_iam_access_key");
    expect(body).not.toContain("create");
  });

  test("links only to an http(s) address with nothing in it that markdown reads", () => {
    const run = { sha: SHA, stacks: [stack({ planJobId: 1 })] };
    for (const projectUrl of ["javascript:alert(1)", "https://x/a)b", "https://x/ a", undefined]) {
      expect(renderNote({ run, notice: null, projectUrl })).not.toContain("[job]");
    }
    expect(renderNote({ run, notice: null, projectUrl: `${URL}/` })).toContain(`(${URL}/-/jobs/1)`);
  });

  test("cannot be broken out of by a stored status or error, nor by text from a repository", () => {
    const body = renderNote({
      run: {
        sha: SHA,
        stacks: [stack({ status: "queued|x", error: "a\n| b | [c](http://evil) @all `d`" })],
      },
      notice: inline("stacks/x/stack.yml: name\n\n# Heading [x](http://evil) @all `code`"),
      projectUrl: URL,
    });
    const rows = body.split("\n").filter((l) => l.startsWith("| `net`"));
    expect(rows).toHaveLength(1);
    // nothing in a cell can start a link, a mention, a tag or another cell
    const cells = (rows[0] ?? "").split("|");
    expect(cells).toHaveLength(8);
    expect(cells[2]).not.toMatch(/[\][<>@`*_\\]/);
    // the notice is one code span on one line
    const notice = body.split("\n").find((l) => l.includes("Heading"));
    expect(notice?.startsWith("`") && notice.endsWith("`")).toBe(true);
    expect(notice?.slice(1, -1)).not.toContain("`");
  });

  test("cuts long text short", () => {
    expect(inline("x".repeat(500))).toHaveLength(202);
    expect(inline("x".repeat(500), 10)).toBe(`\`${"x".repeat(10)}\``);
  });

  test("says why nothing was planned when there is no run, and still says what the note is", () => {
    const body = renderNote({ notice: "No stack is affected.", projectUrl: URL });
    expect(body).toContain("No stack is affected.");
    expect(body).not.toContain("| Stack |");
    expect(body).toContain("updated, not added to");
  });
});

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let org: string;
const gitlab = () =>
  createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });
beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  org = (await createOrganization(t.db, { slug: "n", name: "N" })).id;
  await createConnection(t.db, keys, {
    organizationId: org,
    type: "gitlab",
    name: "live",
    config: { baseUrl: mock.url },
    token: mock.token,
  });
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

let n = 0;
async function world(withRun = true) {
  const id = ++n;
  const path = `nn/p${id}`;
  const gl = mock.addProject({ path });
  const api = gitlab();
  await api.repository.createBranch(gl.id, "feature", "main");
  const mr = await api.mergeRequests.create(gl.id, {
    sourceBranch: "feature",
    targetBranch: "main",
    title: "t",
  });
  const project = await createProject(t.db, {
    organizationId: org,
    name: `p${id}`,
    gitlabProjectId: gl.id,
  });
  const run = withRun
    ? await createRun(t.db, {
        organizationId: org,
        projectId: project.id,
        ref: "feature",
        sha: SHA,
        mergeRequestIid: mr.iid,
        stacks: ["net"],
      })
    : undefined;
  const at = { organizationId: org, projectId: project.id, gitlabProjectId: gl.id };
  const notes = () => mock.mrNotes(path, mr.iid);
  const refresh = (only?: string) => refreshNote({ db: t.db }, at, mr.iid, api, only);
  return { api, gl, mr, project, run, at, notes, refresh };
}

describe("writing the note", () => {
  test("makes the note the first time and updates that one every time after", async () => {
    const w = await world();
    await w.refresh();
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.body).toContain("| `net` | queued |");
    const first = w.notes()[0]?.id;
    await w.refresh();
    await w.refresh();
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.id).toBe(first);
    // the id is kept, so the next process finds the same note
    await withMergeRequest(t.db, org, w.project.id, w.mr.iid, async (_tx, row) => {
      expect(row.noteId).toBe(first as number);
    });
  });

  test("shows the estimate against the organization's limits as they are when it is written", async () => {
    const w = await world();
    await storePlanSummary(t.db, org, w.project.id, w.run?.id as string, "net", {
      add: 1,
      change: 0,
      destroy: 0,
      resources: [],
      cost: { monthlyDelta: 150, monthlyTotal: 900, currency: "USD", tool: "infracost" },
    });
    await w.refresh();
    // no limit: the estimate is shown and judges nothing
    expect(w.notes()[0]?.body).toContain("estimate by `infracost`); no limit");
    const limit = await setCostLimit(t.db, {
      organizationId: org,
      tag: null,
      maxMonthlyDelta: 100,
      warnAt: null,
      currency: "USD",
    });
    await w.refresh();
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.body).toContain(
      "- `net`: +150.00 USD a month, total 900.00 USD (estimate by `infracost`); limit 100.00 USD: deny (`cost-over-limit`)",
    );
    // a limit of another organization is not this one's
    await setCostLimit(t.db, {
      organizationId: (await createOrganization(t.db, { slug: "n2", name: "N2" })).id,
      tag: null,
      maxMonthlyDelta: 1,
      warnAt: null,
      currency: "USD",
    });
    await w.refresh();
    expect(w.notes()[0]?.body).toContain("limit 100.00 USD");
    expect(limit?.row.maxMonthlyDelta).toBe(100);
  });

  test("shows the secret gate's verdict as it is when it is written, and for this project's findings only", async () => {
    const w = await world();
    const other = await world();
    const seen = (projectId: string, fingerprint: string) =>
      upsertFindings(t.db, {
        organizationId: org,
        projectId,
        ref: "main",
        findings: [
          {
            fingerprint,
            rule: "aws-access-token",
            path: "a.ts",
            line: 1,
            commit: "a1b2c3d",
            severity: "high",
          },
        ],
      });
    await seen(w.project.id, "f1");
    await seen(other.project.id, "f2");
    await seen(other.project.id, "f3");
    await w.refresh();
    // the gate is off: nothing is said
    expect(w.notes()[0]?.body).not.toContain("Secrets:");
    await setSecretGate(t.db, org, "warn");
    try {
      await w.refresh();
      expect(w.notes()[0]?.body).toContain("Secrets: 1 open finding on the default branch");
      await setSecretGate(t.db, org, "deny");
      await w.refresh();
      expect(w.notes()[0]?.body).toContain("`secret-findings-open`, deny");
    } finally {
      await setSecretGate(t.db, org, "off");
    }
  });

  test("makes a new note when someone deleted it", async () => {
    const w = await world();
    await w.refresh();
    const gone = w.notes()[0]?.id as number;
    mock.deleteMrNote(`nn/p${n}`, w.mr.iid, gone);
    await w.refresh();
    expect(w.notes()).toHaveLength(1);
    expect(w.notes()[0]?.id).not.toBe(gone);
    await w.refresh();
    expect(w.notes()).toHaveLength(1);
  });

  test("two at once make one note", async () => {
    const w = await world();
    await Promise.all([w.refresh(), w.refresh(), w.refresh()]);
    expect(w.notes()).toHaveLength(1);
  });

  test("writes nothing when there is no run and nothing to say, and says the notice when there is one", async () => {
    const w = await world(false);
    await w.refresh();
    expect(w.notes()).toEqual([]);
    await withMergeRequest(t.db, org, w.project.id, w.mr.iid, async (tx, row) => {
      await writeNote(tx, { ...row, notice: "No stack is affected." }, w.api, w.gl.id);
    });
    expect(w.notes()[0]?.body).toContain("No stack is affected.");
  });

  test("an event of a run that is not the newest writes nothing", async () => {
    const w = await world();
    await w.refresh("another run");
    expect(w.notes()).toEqual([]);
    await w.refresh(w.run?.id);
    expect(w.notes()).toHaveLength(1);
  });

  test("a failure of GitLab leaves the note as it was and fails the caller, so that the queue retries", async () => {
    const w = await world();
    await w.refresh();
    mock.inject({ method: "PUT", status: 500, times: 1 });
    await expect(w.refresh()).rejects.toThrow();
    await w.refresh();
    expect(w.notes()).toHaveLength(1);
  });
});
