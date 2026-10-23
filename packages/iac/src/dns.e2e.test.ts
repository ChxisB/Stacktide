import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { DNS_SUMMARY_FILTER, generatePipeline } from "./pipeline-gen";
import type { Stack } from "./scan";

/**
 * The opt-in run of a zone's generated jobs against the real DNSControl and its `BIND` provider (DNS-13): the plan
 * job's script, the apply job's script and the summary's `jq`, each in a checkout of its own as a runner has, with
 * the zone's records in a directory outside them as a provider has. Setting ORCH_E2E_DNSCONTROL=1 turns it on; the
 * binary is DNSCONTROL_BIN or `dnscontrol` on the path. Nothing leaves the machine: the plan's report reaches the
 * apply job through a local server that answers the job-artifacts URL, and without `wget` (the stock runner image
 * has it, a laptop may not) a shim over `curl` stands in for it.
 */
const on = process.env.ORCH_E2E_DNSCONTROL === "1";

if (!on) {
  test.skip("real DNSControl with BIND (set ORCH_E2E_DNSCONTROL=1 to run it)", () => {});
} else {
  const bin = process.env.DNSCONTROL_BIN || Bun.which("dnscontrol");
  const missing = [
    bin ? "" : "dnscontrol (or DNSCONTROL_BIN)",
    ...["sh", "jq", "curl"].filter((t) => !Bun.which(t)),
  ].filter(Boolean);
  if (missing.length > 0) throw new Error(`ORCH_E2E_DNSCONTROL=1 needs ${missing.join(", ")}`);

  const TOKEN = "job-token-e2e";
  const ARTIFACT = "/api/v4/projects/42/jobs/7/artifacts/dns/report.json";
  const stack: Stack = {
    name: "zone",
    path: "dns",
    tool: "dnscontrol",
    version: "5.5.0",
    tags: [],
    dependsOn: [],
    watch: [],
    applyOn: "command",
    backend: "unchecked",
  };
  const scriptOf = (yaml: string, job: string) =>
    ((parse(yaml) as Record<string, { script: string[] }>)[job]?.script ?? []).join("\n");
  const planScript = scriptOf(
    generatePipeline({
      action: "plan",
      stacks: [stack],
      select: ["zone"],
      audience: "orch.example.com",
      apiUrl: "https://orch.example.com",
      summaryPath: "/runs/0b9e5bd2/plan-summary",
      helperImage: "registry.example.com/orch/ci-helper:1.0.0",
    }),
    "plan:zone",
  );
  const applyScript = scriptOf(
    generatePipeline({
      action: "apply",
      stacks: [stack],
      select: ["zone"],
      planJobs: { zone: 7 },
      images: { dnscontrol: "registry.example.com/orch/dnscontrol" },
    }),
    "apply:zone",
  );

  const fixtures = join(import.meta.dir, "fixtures/dnscontrol");
  const WWW = 'A("www", "192.0.2.2")';
  const config = (...records: string[]) =>
    [
      'var REG = NewRegistrar("none");',
      'var DNS = NewDnsProvider("bind");',
      `D("example.test", REG, DnsProvider(DNS), NO_PURGE, ${records.join(", ")});`,
      "",
    ].join("\n");

  let tools: string;
  let artifact = "";
  let server: ReturnType<typeof Bun.serve>;
  let root: string;
  beforeAll(async () => {
    tools = await mkdtemp(join(tmpdir(), "orch-dns-e2e-bin-"));
    await symlink(bin as string, join(tools, "dnscontrol"));
    if (!Bun.which("wget")) {
      await writeFile(
        join(tools, "wget"),
        `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in --header) h="$2"; shift ;; -O) out="$2"; shift ;; -q) ;; *) url="$1" ;; esac; shift; done
exec curl --fail --silent --header "$h" --output "$out" "$url"
`,
        { mode: 0o755 },
      );
    }
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const { pathname } = new URL(req.url);
        if (req.headers.get("JOB-TOKEN") !== TOKEN) return new Response("", { status: 401 });
        if (pathname !== ARTIFACT || !artifact) return new Response("", { status: 404 });
        return new Response(Bun.file(artifact));
      },
    });
  });
  afterAll(async () => {
    server?.stop(true);
    await rm(tools, { recursive: true, force: true });
  });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orch-dns-e2e-"));
    artifact = "";
    // the zone as the provider has it
    await mkdir(join(root, "remote"));
    await copyFile(join(fixtures, "get-zones.zone"), join(root, "remote/example.test.zone"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  let n = 0;
  /** A fresh checkout of the repository, as each runner job has, holding the given `dnsconfig.js`. */
  async function checkout(dnsconfig: string) {
    const dir = join(root, `checkout-${++n}`);
    await mkdir(join(dir, "dns"), { recursive: true });
    await writeFile(join(dir, "dns/dnsconfig.js"), dnsconfig);
    await writeFile(
      join(dir, "dns/creds.json"),
      JSON.stringify({ bind: { TYPE: "BIND", directory: join(root, "remote") } }),
    );
    return dir;
  }
  async function job(script: string, cwd: string) {
    const proc = Bun.spawn(["sh", "-e", "-c", script], {
      cwd,
      env: {
        PATH: `${tools}:${process.env.PATH}`,
        CI_API_V4_URL: `http://127.0.0.1:${server.port}/api/v4`,
        CI_PROJECT_ID: "42",
        CI_JOB_TOKEN: TOKEN,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, said: out + err };
  }
  /** What the plan's summary job posts, from the report the plan job kept. */
  async function summary(dir: string) {
    const proc = Bun.spawn(
      ["jq", "-c", "--arg", "stack", "zone", DNS_SUMMARY_FILTER, join(dir, "dns/report.json")],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return JSON.parse(out);
  }
  const zoneFile = () => readFile(join(root, "remote/example.test.zone"), "utf8");

  test("add a record, plan, apply, plan again: the second plan is empty", async () => {
    const wanted = config(WWW, 'A("api", "192.0.2.9")');

    const planned = await checkout(wanted);
    // the job's log is fixed words: the tool's output, record values in it, is in the files the job keeps
    expect(await job(planScript, planned)).toEqual({ code: 0, said: "" });
    expect(await readFile(join(planned, "dns/preview.txt"), "utf8")).toContain("192.0.2.9");
    expect(JSON.parse(await readFile(join(planned, "dns/ir.json"), "utf8")).domains).toHaveLength(
      1,
    );
    const posted = await summary(planned);
    expect(posted).toEqual({
      stack: "zone",
      add: 1,
      change: 0,
      destroy: 0,
      resources: [{ address: "example.test/api/A", actions: ["create"] }],
    });
    // a plan changes nothing
    expect(await zoneFile()).not.toContain("192.0.2.9");

    // the apply job is another checkout, and reads the plan job's report from the artifacts URL
    artifact = join(planned, "dns/report.json");
    const applied = await checkout(wanted);
    expect(await job(applyScript, applied)).toEqual({ code: 0, said: "" });
    expect(await readFile(join(applied, "dns/push.txt"), "utf8")).not.toBe("");
    expect(await zoneFile()).toContain("192.0.2.9");
    // the records it was not told about are still there
    expect(await zoneFile()).toContain("_canary");

    const again = await checkout(wanted);
    expect(await job(planScript, again)).toEqual({ code: 0, said: "" });
    expect(await summary(again)).toEqual({
      stack: "zone",
      add: 0,
      change: 0,
      destroy: 0,
      resources: [],
    });
  });

  test("a zone whose changes are not the planned ones is not pushed", async () => {
    const planned = await checkout(config(WWW, 'A("api", "192.0.2.9")'));
    expect(await job(planScript, planned)).toEqual({ code: 0, said: "" });
    artifact = join(planned, "dns/report.json");

    // the config moved on between the plan and the apply: same name, another address
    const applied = await checkout(config(WWW, 'A("api", "192.0.2.10")'));
    const r = await job(applyScript, applied);
    expect(r.code).toBe(1);
    expect(r.said).toBe(
      "the zone's changes are not the ones that were planned: nothing was pushed. Plan again.\n",
    );
    expect(await zoneFile()).not.toContain("api");
    expect(await Bun.file(join(applied, "dns/push.txt")).exists()).toBe(false);
  });
}
