import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLogger, MAX_REPORT_BYTES } from "@orch/core";
import { envKeyProvider } from "@orch/crypto";
import {
  auditEvents,
  createConnection,
  createOrganization,
  createProject,
  listFindings,
  WEBHOOK_QUEUE,
} from "@orch/db";
import { createTestDb, type TestDb } from "@orch/db/testing";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { eq } from "drizzle-orm";
import { pipelineEventHandler } from "./pipeline-runs";
import type { JobContext } from "./worker";

const keys = envKeyProvider(`k1:${Buffer.alloc(32, 1).toString("base64")}`);
const CI = "secret_detection:\n  script:\n    - echo scan\n";
/** What a planted secret looks like: if it is in a row, a log line or an audit event, a field was copied that must not be. */
const SECRET = "AKIAIOSFODNN7CANARY0";

let t: TestDb;
let mock: ReturnType<typeof createMockGitlab>;
let org: string;
let conn: string;
const lines: string[] = [];
const logger = createLogger({ level: "debug", write: (line) => lines.push(line) });

const client = () =>
  createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  });

beforeAll(async () => {
  t = await createTestDb();
  mock = createMockGitlab({ scopes: ["api"] });
  org = (await createOrganization(t.db, { slug: "scan", name: "Scan" })).id;
  conn = (
    await createConnection(t.db, keys, {
      organizationId: org,
      type: "gitlab",
      name: "live",
      config: { baseUrl: mock.url },
      token: mock.token,
    })
  ).id;
});
afterAll(async () => {
  mock.stop();
  await t.drop();
});

const handler = () => pipelineEventHandler({ db: t.db, gitlab: async () => client() });
const job = (payload: Record<string, unknown>): JobContext => ({
  id: "job",
  queue: WEBHOOK_QUEUE,
  payload,
  attempt: 1,
  maxAttempts: 5,
  log: logger,
  signal: new AbortController().signal,
});

const vuln = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  category: "secret_detection",
  name: "AWS API key",
  description: `Found ${SECRET}`,
  severity: "Critical",
  raw_source_code_extract: `aws_key = ${SECRET}`,
  location: {
    file: "src/config.ts",
    start_line: 7,
    commit: { sha: "a1b2c3d4e5f6", message: `add ${SECRET}`, author: SECRET },
  },
  identifiers: [{ type: "gitleaks_rule_id", name: "rule", value: "aws-access-token" }],
  ...over,
});
const report = (vulnerabilities: unknown[], scan: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: "15.1.0",
    scan: { status: "success", type: "secret_detection", ...scan },
    vulnerabilities,
  });

let n = 0;
/** A linked project whose CI is a secret-detection job; `scan` plays a run of it and tells the platform. */
async function world(ci = CI) {
  const id = ++n;
  const gl = mock.addProject({ path: `fx/s${id}`, files: { ".gitlab-ci.yml": ci } });
  const project = await createProject(t.db, {
    organizationId: org,
    name: `s${id}`,
    gitlabProjectId: gl.id,
  });
  const event = (pipelineId: number) => ({
    event: "pipeline",
    organizationId: org,
    connectionId: conn,
    projectId: gl.id,
    pipelineId,
  });
  const branches = new Set<string>();
  /** A pipeline on `ref` that finished with `body` as the job's artifact (none when undefined). */
  const scan = async (
    body: string | undefined,
    o: { ref?: string; status?: "success" | "failed"; jobName?: string } = {},
  ) => {
    const ref = o.ref ?? "main";
    if (ref !== "main" && !branches.has(ref)) {
      await client().repository.createBranch(gl.id, ref, "main");
      branches.add(ref);
    }
    const p = (await client().pipelines.trigger(gl.id, ref)).id;
    mock.finishPipeline(p, o.status ?? "success");
    if (body !== undefined)
      mock.addArtifact(p, o.jobName ?? "secret_detection", "gl-secret-detection-report.json", body);
    return p;
  };
  const run = (pipelineId: number) => handler()(job(event(pipelineId)));
  const findings = async () =>
    Object.fromEntries(
      (await listFindings(t.db, org, project.id, { limit: 100 })).map((f) => [f.fingerprint, f]),
    );
  const statuses = async () =>
    Object.fromEntries(Object.entries(await findings()).map(([k, f]) => [k, f.status]));
  return { gl, project, scan, run, findings, statuses };
}

const requestsTo = (re: RegExp) => mock.requests.filter((r) => re.test(r.path));

describe("secret findings from a finished pipeline", () => {
  test("the report's findings are stored where they are, and nothing of what they are", async () => {
    const w = await world();
    const p = await w.scan(report([vuln("f1"), vuln("f2", { severity: "High" })]));
    await w.run(p);
    const rows = await w.findings();
    expect(Object.keys(rows).sort()).toEqual(["f1", "f2"]);
    expect(rows.f1).toMatchObject({
      rule: "aws-access-token",
      path: "src/config.ts",
      line: 7,
      commit: "a1b2c3d4e5f6",
      severity: "critical",
      ref: "main",
      status: "open",
    });
    expect(rows.f2?.severity).toBe("high");
  });

  test("a run again is the same findings; one the report no longer has is resolved", async () => {
    const w = await world();
    await w.run(await w.scan(report([vuln("f1"), vuln("f2")])));
    await w.run(await w.scan(report([vuln("f1"), vuln("f2")])));
    expect(await w.statuses()).toEqual({ f1: "open", f2: "open" });
    // the same pipeline handled twice changes nothing either
    const p = await w.scan(report([vuln("f1")]));
    await w.run(p);
    await w.run(p);
    expect(await w.statuses()).toEqual({ f1: "open", f2: "resolved" });
    // and it comes back open when a scan finds it again
    await w.run(await w.scan(report([vuln("f1"), vuln("f2")])));
    expect(await w.statuses()).toEqual({ f1: "open", f2: "open" });
  });

  test("a scan that did not finish, or did not look at everything, resolves nothing", async () => {
    const w = await world();
    await w.run(await w.scan(report([vuln("f1"), vuln("f2")])));
    await w.run(await w.scan(report([vuln("f1")], { status: "failure" })));
    await w.run(await w.scan(report([vuln("f1")], { partial_scan: { mode: "differential" } })));
    expect(await w.statuses()).toEqual({ f1: "open", f2: "open" });
  });

  test("a report with an entry that could not be read resolves nothing: that entry might be a known finding", async () => {
    const w = await world();
    await w.run(await w.scan(report([vuln("f1"), vuln("f2")])));
    const unreadable = vuln("f2", {
      location: { file: "bad\u0007path", commit: { sha: "a1b2c3d4" } },
    });
    await w.run(await w.scan(report([vuln("f1"), unreadable])));
    expect(await w.statuses()).toEqual({ f1: "open", f2: "open" });
  });

  test("a scan of another branch is stored with its branch and resolves nothing on the default branch", async () => {
    const w = await world();
    await w.run(await w.scan(report([vuln("main-1")])));
    await w.run(await w.scan(report([vuln("branch-1")]), { ref: "feature/x" }));
    const rows = await w.findings();
    expect(rows["main-1"]).toMatchObject({ ref: "main", status: "open" });
    expect(rows["branch-1"]).toMatchObject({ ref: "feature/x", status: "open" });
    // a clean branch does not clear the default branch's findings, nor its own earlier ones
    await w.run(await w.scan(report([]), { ref: "feature/x" }));
    expect(await w.statuses()).toEqual({ "main-1": "open", "branch-1": "open" });
    // a clean default branch does clear its own
    await w.run(await w.scan(report([])));
    expect(await w.statuses()).toEqual({ "main-1": "resolved", "branch-1": "open" });
  });

  test("a failed pipeline still has its report: the job passing or failing is not the scan's verdict", async () => {
    const w = await world();
    await w.run(await w.scan(report([vuln("f1")]), { status: "failed" }));
    expect(await w.statuses()).toEqual({ f1: "open" });
  });

  test("no scan job, an unfinished pipeline, or a job that did not run: nothing is fetched", async () => {
    const quiet = await world("test:\n  script:\n    - echo hi\n");
    mock.requests.splice(0);
    await quiet.run(await quiet.scan(undefined));
    expect(requestsTo(/\/artifacts\//)).toEqual([]);

    const w = await world();
    const running = (await client().pipelines.trigger(w.gl.id, "main")).id;
    mock.requests.splice(0);
    await w.run(running);
    expect(requestsTo(/\/jobs$/)).toEqual([]);
    expect(requestsTo(/\/artifacts\//)).toEqual([]);

    // the job was canceled: there is no report to read
    const cancelled = await w.scan(report([vuln("f1")]));
    mock.setJobStatus(cancelled, "secret_detection", "canceled");
    mock.requests.splice(0);
    await w.run(cancelled);
    expect(requestsTo(/\/artifacts\//)).toEqual([]);
    expect(await w.statuses()).toEqual({});
  });

  test("a report that was never made is not an error", async () => {
    const w = await world();
    await w.run(await w.scan(undefined));
    expect(await w.statuses()).toEqual({});
  });

  test("a report that is too large is not read, and is not retried", async () => {
    const w = await world();
    const p = await w.scan("x".repeat(MAX_REPORT_BYTES + 1));
    lines.length = 0;
    await w.run(p);
    expect(await w.statuses()).toEqual({});
    expect(lines.join("\n")).toContain("too large");
  });

  test("a report that is not one, or has too many findings, is dropped with its reason and no text", async () => {
    const w = await world();
    lines.length = 0;
    await w.run(await w.scan(`not json ${SECRET}`));
    await w.run(await w.scan(JSON.stringify({ vulnerabilities: "no", note: SECRET })));
    expect(await w.statuses()).toEqual({});
    expect(lines.join("\n")).toContain("malformed");
    expect(lines.join("\n")).not.toContain(SECRET);
  });

  test("GitLab refusing the token drops the event; GitLab failing is retried", async () => {
    const w = await world();
    const p = await w.scan(report([vuln("f1")]));
    mock.inject({ method: "GET", path: /\/artifacts\//, status: 403 });
    lines.length = 0;
    await w.run(p);
    expect(lines.join("\n")).toContain("GitLab refuses the token");
    expect(await w.statuses()).toEqual({});

    mock.inject({ method: "GET", path: /\/artifacts\//, status: 500 });
    await expect(w.run(p)).rejects.toThrow();
    // and the retry finds it
    await w.run(p);
    expect(await w.statuses()).toEqual({ f1: "open" });
  });

  test("an unlinked project is not scanned", async () => {
    const gl = mock.addProject({ path: "fx/unlinked", files: { ".gitlab-ci.yml": CI } });
    const p = (await client().pipelines.trigger(gl.id, "main")).id;
    mock.finishPipeline(p, "success");
    mock.requests.splice(0);
    await handler()(
      job({
        event: "pipeline",
        organizationId: org,
        connectionId: conn,
        projectId: gl.id,
        pipelineId: p,
      }),
    );
    expect(requestsTo(/\/(jobs|artifacts)/)).toEqual([]);
  });

  test("nothing of a secret reaches a row, a log line or an audit event", async () => {
    const w = await world();
    lines.length = 0;
    await w.run(await w.scan(report([vuln("f1"), vuln("f2")])));
    await w.run(await w.scan(report([vuln("f1")])));
    expect(JSON.stringify(await w.findings())).not.toContain(SECRET);
    expect(lines.join("\n")).not.toContain(SECRET);
    const audit = await t.db.select().from(auditEvents).where(eq(auditEvents.organizationId, org));
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });
});
