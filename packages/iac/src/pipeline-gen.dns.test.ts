import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { lintReport, lintZones } from "./lint";
import {
  type ApplyInput,
  DNS_SUMMARY_FILTER,
  GenerateError,
  generatePipeline,
  type PlanInput,
} from "./pipeline-gen";
import type { PolicySet } from "./policy";
import type { Stack } from "./scan";

// DNS-4 (ADR-0018): a DNS zone is a stack whose plan is `dnscontrol preview`, mapped to the summary a Terraform plan posts.
// biome-ignore lint/suspicious/noExplicitAny: a job read back from YAML, looked into loosely by the tests
type Job = Record<string, any>;
const jobsOf = (yaml: string): Record<string, Job> => {
  const { stages: _, ...jobs } = parse(yaml);
  return jobs;
};

const CANARY = "CANARY-VALUE-7f3a";
const fixture = (name: string) => join(import.meta.dir, "fixtures/dnscontrol", name);

const zone = (over: Partial<Stack> = {}): Stack => ({
  name: "zone",
  path: "dns",
  tool: "dnscontrol",
  version: "5.5.0",
  tags: [],
  dependsOn: [],
  watch: [],
  applyOn: "command",
  backend: "unchecked",
  ...over,
});

const plan = (over: Partial<PlanInput> = {}): PlanInput => ({
  action: "plan",
  stacks: [zone()],
  select: ["zone"],
  audience: "orch.example.com",
  apiUrl: "https://orch.example.com",
  summaryPath: "/runs/0b9e5bd2/plan-summary",
  helperImage: "registry.example.com/orch/ci-helper:1.0.0",
  ...over,
});

const withEnvironment = () =>
  plan({
    stacks: [zone({ environment: "dns" })],
    images: { dnscontrol: "registry.example.com/orch/dnscontrol" },
  });

// the apply of a zone needs an image with jq and wget in it, which the stock one has not
const APPLY_IMAGE = { dnscontrol: "registry.example.com/orch/dnscontrol" };
const apply = (over: Partial<ApplyInput> = {}): ApplyInput => ({
  action: "apply",
  stacks: [zone()],
  select: ["zone"],
  planJobs: { zone: 7 },
  images: APPLY_IMAGE,
  ...over,
});

const applyWithEnvironment = () =>
  apply({
    stacks: [zone({ environment: "dns" })],
    platform: { apiUrl: "https://orch.example.com", audience: "orch.example.com" },
  });

const failure = (fn: () => unknown): GenerateError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GenerateError) return e;
    throw e;
  }
  throw new Error("it did not throw");
};

describe("the plan of a DNS zone", () => {
  test("snapshot", () => {
    expect(generatePipeline(plan())).toMatchSnapshot();
    expect(generatePipeline(withEnvironment())).toMatchSnapshot();
  });

  test("runs the official image at the stack's version, checks offline, then previews with a report", () => {
    const job = jobsOf(generatePipeline(plan()))["plan:zone"] as Job;
    expect(job.image).toEqual({ name: "dnscontrol/dnscontrol:5.5.0", entrypoint: [""] });
    expect(job.script[0]).toBe("cd dns");
    const run = job.script.join("\n");
    expect(run).toContain("dnscontrol check");
    expect(run).toContain("dnscontrol preview --report report.json");
    // nothing of Terraform, and never the option that lets a config fetch from the network
    expect(run).not.toMatch(/terraform|tofu|init|--allow-fetch/);
  });

  test("a zone has no Terraform state: the job carries none of GitLab's settings", () => {
    const yaml = generatePipeline(plan());
    expect(yaml).not.toContain("TF_HTTP");
    expect(yaml).not.toContain("CI_JOB_TOKEN");
    expect(jobsOf(yaml)["plan:zone"]?.variables).toBeUndefined();
  });

  test("the preview holds record values, so it goes to an artifact for developers and not to the job log", () => {
    const job = jobsOf(generatePipeline(plan()))["plan:zone"] as Job;
    expect(job.artifacts).toEqual({
      paths: ["dns/report.json", "dns/preview.txt", "dns/ir.json"],
      expire_in: "1 week",
      access: "developer",
      // a failed preview is the one a developer must read, and its error text echoes values too
      when: "always",
    });
    const line = job.script.find((l: string) => l.includes("dnscontrol preview")) as string;
    expect(line).toContain("> preview.txt 2>&1");
    // what the log says on failure is fixed
    expect(line).toContain('echo "dnscontrol failed');
  });

  test("with an environment the tool runs through orch, with no prefix: creds.json names the variables", () => {
    const job = jobsOf(generatePipeline(withEnvironment()))["plan:zone"] as Job;
    expect(job.image.name).toBe("registry.example.com/orch/dnscontrol:5.5.0");
    expect(job.script.slice(1, 3)).toEqual(['login="$(orch ci login)"', 'eval "$login"']);
    expect(job.script.join("\n")).toContain("orch run -- dnscontrol preview --report report.json");
    expect(job.script.join("\n")).not.toContain("--prefix");
    expect(job.environment).toEqual({ name: "dns", action: "access" });
    expect(job.id_tokens.ORCH_ID_TOKEN).toEqual({ aud: "orch.example.com" });
  });

  test("an environment needs an image that holds orch: the stock one does not", () => {
    const e = failure(() => generatePipeline(plan({ stacks: [zone({ environment: "dns" })] })));
    expect(e.problems.join("\n")).toContain("pass images.dnscontrol");
  });

  test("the summary job reads the report and posts the same summary a plan does", () => {
    const job = jobsOf(generatePipeline(plan()))["summary:zone"] as Job;
    expect(job.needs).toEqual([{ job: "plan:zone", artifacts: true }]);
    const filter = job.script.find((l: string) => l.startsWith("jq ")) as string;
    expect(filter).toContain("dns/report.json");
    expect(job.script.at(-1)).toContain('"$ORCH_API_URL/runs/0b9e5bd2/plan-summary"');
  });

  test("policy sets judge Terraform plans: a zone they would reach is refused, not left unjudged", () => {
    const set: PolicySet = {
      name: "all",
      source: "acme/policy",
      ref: "main",
      path: ".",
      tag: "prod",
    };
    const e = failure(() =>
      generatePipeline(
        plan({
          stacks: [zone({ tags: ["prod"] })],
          policy: { sets: [set], image: "registry.example.com/conftest:1", path: "/runs/x/policy" },
        }),
      ),
    );
    expect(e.problems.join("\n")).toContain("DNS zone");
  });

  test("a zone is not costed: its plan is no Terraform plan", () => {
    const withCost = generatePipeline(
      plan({ cost: { stacks: ["zone"], image: "registry.example.com/infracost:1" } }),
    );
    expect(Object.keys(jobsOf(withCost))).toEqual(["plan:zone", "summary:zone"]);
  });

  test("a Terraform stack beside a zone is planned as it always was", () => {
    const tf: Stack = {
      ...zone(),
      name: "net",
      path: "net",
      tool: "terraform",
      version: "1.9.8",
      backend: "http",
    };
    const jobs = jobsOf(generatePipeline(plan({ stacks: [zone(), tf], select: ["net", "zone"] })));
    expect(jobs["plan:net"]?.script).toContain("terraform init -input=false");
    expect(jobs["plan:net"]?.variables?.TF_HTTP_ADDRESS).toBeDefined();
    expect(jobs["plan:zone"]?.script.join("\n")).not.toContain("terraform");
  });
});

describe("the apply of a DNS zone (DNS-5)", () => {
  const scriptOf = (yaml: string) => (jobsOf(yaml)["apply:zone"] as Job).script as string[];
  const at = (script: string[], needle: string) => script.findIndex((l) => l.includes(needle));

  test("snapshot", () => {
    expect(generatePipeline(apply())).toMatchSnapshot();
    expect(generatePipeline(applyWithEnvironment())).toMatchSnapshot();
  });

  test("fetches the plan's report, previews again, and pushes only if the change set is the same", () => {
    const script = scriptOf(generatePipeline(apply()));
    const order = [
      "cd dns",
      "-O plan-report.json",
      "> planned.txt",
      "dnscontrol preview --report report.json",
      "> current.txt",
      "cmp -s planned.txt current.txt",
      "dnscontrol push",
    ].map((needle) => at(script, needle));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(script[0]).toBe("cd dns");
    // the plan's report comes from the job that made it, as a Terraform plan does
    expect(script[at(script, "-O plan-report.json")]).toContain(
      "$CI_API_V4_URL/projects/$CI_PROJECT_ID/jobs/7/artifacts/dns/report.json",
    );
    expect(script.join("\n")).not.toMatch(/terraform|tofu|init|plan\.tfplan|--allow-fetch/);
  });

  test("what the tool prints goes to an artifact for developers, and what the log says is fixed", () => {
    const job = jobsOf(generatePipeline(apply()))["apply:zone"] as Job;
    expect(job.artifacts).toEqual({
      paths: ["dns/preview.txt", "dns/push.txt"],
      expire_in: "1 week",
      access: "developer",
      when: "always",
    });
    for (const needle of ["dnscontrol preview", "dnscontrol push"]) {
      const line = job.script.find((l: string) => l.includes(needle)) as string;
      expect(line).toMatch(/> (preview|push)\.txt 2>&1/);
      expect(line).toContain('echo "dnscontrol');
    }
    // an apply is never cut off by a newer push, and the stack's runs never overlap
    expect(job.interruptible).toBeUndefined();
    expect(job.resource_group).toBe("stack-zone");
  });

  test("a zone has no Terraform state: the job carries none of GitLab's settings", () => {
    expect(generatePipeline(apply())).not.toContain("TF_HTTP");
    expect(jobsOf(generatePipeline(apply()))["apply:zone"]?.variables).toBeUndefined();
  });

  test("the guard does not leave a value in the log: the lines that read reports write to files", () => {
    const script = scriptOf(generatePipeline(apply()));
    for (const line of script.filter((l) => l.includes("jq "))) expect(line).toMatch(/> \w+\.txt$/);
    expect(script[at(script, "cmp -s")]).toContain('echo "the zone');
  });

  test("with an environment it signs in and runs the tool through orch, like the plan", () => {
    const job = jobsOf(generatePipeline(applyWithEnvironment()))["apply:zone"] as Job;
    expect(job.image.name).toBe("registry.example.com/orch/dnscontrol:5.5.0");
    expect(job.script.slice(1, 3)).toEqual(['login="$(orch ci login)"', 'eval "$login"']);
    const run = job.script.join("\n");
    expect(run).toContain("orch run -- dnscontrol preview --report report.json");
    expect(run).toContain("orch run -- dnscontrol push");
    expect(run).not.toContain("--prefix");
    expect(job.environment).toEqual({ name: "dns", action: "access" });
    expect(job.id_tokens.ORCH_ID_TOKEN).toEqual({ aud: "orch.example.com" });
    expect(job.variables).toEqual({ ORCH_API_URL: "https://orch.example.com" });
  });

  test("an apply needs an image with jq and wget, which the stock one has not; an environment needs the platform to sign in to", () => {
    const stock = failure(() => generatePipeline(apply({ images: {} })));
    expect(stock.problems.join("\n")).toContain(
      "pass images.dnscontrol (an image with dnscontrol, jq, wget and orch)",
    );
    const e = failure(() => generatePipeline(apply({ stacks: [zone({ environment: "dns" })] })));
    expect(e.problems.join("\n")).toContain("pass platform");
  });

  test("a zone with no environment signs in to nothing, and a missing plan is still refused", () => {
    const job = jobsOf(generatePipeline(apply()))["apply:zone"] as Job;
    expect(job.image.name).toBe("registry.example.com/orch/dnscontrol:5.5.0");
    expect(job.id_tokens).toBeUndefined();
    expect(job.environment).toBeUndefined();
    expect(job.script.join("\n")).not.toContain("orch");
    const e = failure(() => generatePipeline(apply({ planJobs: {} })));
    expect(e.problems.join("\n")).toContain("no saved plan");
  });

  test("a Terraform stack beside a zone is applied as it always was", () => {
    const tf: Stack = {
      ...zone(),
      name: "net",
      path: "net",
      tool: "terraform",
      version: "1.9.8",
      backend: "http",
    };
    const jobs = jobsOf(
      generatePipeline(
        apply({ stacks: [zone(), tf], select: ["net", "zone"], planJobs: { net: 3, zone: 7 } }),
      ),
    );
    expect(jobs["apply:net"]?.script).toContain(
      "terraform apply -input=false -lock-timeout=5m plan.tfplan",
    );
    expect(jobs["apply:zone"]?.script.join("\n")).not.toContain("terraform");
  });
});

describe("the summary filter of a DNS zone", () => {
  const jq = Bun.which("jq");
  const run = async (input: unknown) => {
    const proc = Bun.spawn([jq as string, "-c", "--arg", "stack", "zone", DNS_SUMMARY_FILTER], {
      stdin: new TextEncoder().encode(JSON.stringify(input)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(await proc.exited, err).toBe(0);
    return { text: out, json: JSON.parse(out) };
  };
  const report = async (name: string) => JSON.parse(await readFile(fixture(name), "utf8"));

  test.skipIf(!jq)(
    "a delete, a create and a change: names relative to the zone, types, actions, no value",
    async () => {
      const { text, json } = await run(await report("report-changes.json"));
      expect(json).toEqual({
        stack: "zone",
        add: 1,
        change: 1,
        destroy: 1,
        resources: [
          { address: "example.test/_canary/TXT", actions: ["delete"] },
          { address: "example.test/api/A", actions: ["create"] },
          { address: "example.test/www/A", actions: ["update"] },
        ],
      });
      // the report holds the canary; the summary must not
      expect(JSON.stringify(await report("report-changes.json"))).toContain(CANARY);
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("192.0.2");
    },
  );

  test.skipIf(!jq)("a zone that does not exist yet is one create of the zone", async () => {
    const { json } = await run(await report("report-new-zone.json"));
    expect(json).toEqual({
      stack: "zone",
      add: 1,
      change: 0,
      destroy: 0,
      resources: [{ address: "example.test", actions: ["create"] }],
    });
  });

  test.skipIf(!jq)("a zone that is in sync is an empty summary", async () => {
    const { json } = await run(await report("report-in-sync.json"));
    expect(json).toEqual({ stack: "zone", add: 0, change: 0, destroy: 0, resources: [] });
  });

  test.skipIf(!jq)(
    "the apex is @, and a line it cannot read is an update of the zone, never quoted",
    async () => {
      const { text, json } = await run([
        {
          domain: "example.test",
          corrections: 2,
          correction_details: [
            `+ CREATE example.test TXT "${CANARY}" ttl=300`,
            `something new that says ${CANARY}`,
          ],
        },
      ]);
      expect(json.resources).toEqual([
        { address: "example.test/@/TXT", actions: ["create"] },
        { address: "example.test", actions: ["update"] },
      ]);
      expect(json).toMatchObject({ add: 1, change: 1, destroy: 0 });
      expect(text).not.toContain(CANARY);
    },
  );

  // from the real tool (5.5.0, BIND): with NO_PURGE and a change, the report lists the records it keeps, as lines of the
  // same details, before the change
  test.skipIf(!jq)(
    "the records NO_PURGE keeps are a note, not changes: one create is one add",
    async () => {
      const raw = await report("report-no-purge-changes.json");
      expect(raw[0].correction_details).toHaveLength(6);
      const { text, json } = await run(raw);
      expect(json).toEqual({
        stack: "zone",
        add: 1,
        change: 0,
        destroy: 0,
        resources: [{ address: "example.test/api/A", actions: ["create"] }],
      });
      // the note holds the kept records' values; the summary has none
      expect(JSON.stringify(raw)).toContain(CANARY);
      expect(text).not.toContain(CANARY);
    },
  );

  test.skipIf(!jq)(
    "a note on its own is an empty plan; a line beside it that is not the note is still an update",
    async () => {
      const note = [
        "2 records not being deleted because of NO_PURGE:",
        'A("example.test.", 192.0.2.1),',
      ];
      const only = await run([
        { domain: "example.test", corrections: 2, correction_details: note },
      ]);
      expect(only.json).toMatchObject({ add: 0, change: 0, destroy: 0, resources: [] });
      const beside = await run([
        {
          domain: "example.test",
          corrections: 3,
          correction_details: [...note, `something new that says ${CANARY}`],
        },
      ]);
      expect(beside.json).toMatchObject({ change: 1, resources: [{ address: "example.test" }] });
      expect(beside.text).not.toContain(CANARY);
    },
  );

  test.skipIf(!jq)("two zones in one report keep their own names", async () => {
    const { json } = await run([
      {
        domain: "a.test",
        corrections: 1,
        correction_details: ["+ CREATE www.a.test A 192.0.2.1 ttl=300"],
      },
      {
        domain: "b.test",
        corrections: 1,
        correction_details: ["- DELETE www.b.test CNAME x.b.test. ttl=300"],
      },
    ]);
    expect(json.resources.map((r: { address: string }) => r.address)).toEqual([
      "a.test/www/A",
      "b.test/www/CNAME",
    ]);
  });
});

describe("the lines of a DNS plan, as the runner's shell runs them", () => {
  const sh = Bun.which("sh");
  const jq = Bun.which("jq");
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "orch-dns-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const lineOf = (needle: string) =>
    (jobsOf(generatePipeline(plan()))["plan:zone"] as Job).script.find((l: string) =>
      l.includes(needle),
    ) as string;

  const checkCreds = async (creds: string, env: Record<string, string>) => {
    await writeFile(join(dir, "creds.json"), creds);
    const base = { ...process.env };
    for (const k of ["CF_API_TOKEN", "R53_KEY", "ZONE_DIR"]) delete base[k];
    const proc = Bun.spawn(["sh", "-c", lineOf("creds.json")], {
      cwd: dir,
      env: { ...base, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, said: out + err };
  };

  test.skipIf(!sh)("passes when every $VAR in creds.json is set", async () => {
    const r = await checkCreds('{"cf": {"TYPE": "CLOUDFLAREAPI", "apitoken": "$CF_API_TOKEN"}}', {
      CF_API_TOKEN: CANARY,
    });
    expect(r).toEqual({ code: 0, said: "" });
  });

  test.skipIf(!sh)(
    "stops, naming the variable and never a value, when one is unset or empty",
    async () => {
      const creds = '{"a": {"apitoken": "$CF_API_TOKEN"}, "b": {"key": "$R53_KEY"}}';
      for (const env of [{ CF_API_TOKEN: CANARY }, { CF_API_TOKEN: CANARY, R53_KEY: "" }] as Record<
        string,
        string
      >[]) {
        const r = await checkCreds(creds, env);
        expect(r.code).toBe(1);
        expect(r.said).toBe("creds.json names $R53_KEY, which is not set or is empty\n");
      }
    },
  );

  test.skipIf(!sh)(
    "a literal value is no reference, and a missing creds.json is the tool's to report",
    async () => {
      expect((await checkCreds('{"bind": {"directory": "zones"}}', {})).code).toBe(0);
      await rm(join(dir, "creds.json"), { force: true });
      const proc = Bun.spawn(["sh", "-c", lineOf("creds.json")], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
    },
  );

  test.skipIf(!jq)(
    "the generated summary line, run by sh, writes the summary of the report",
    async () => {
      const line = (jobsOf(generatePipeline(plan()))["summary:zone"] as Job).script.find(
        (l: string) => l.startsWith("jq "),
      ) as string;
      await mkdir(join(dir, "dns"), { recursive: true });
      await writeFile(join(dir, "dns/report.json"), await readFile(fixture("report-changes.json")));
      const proc = Bun.spawn(["sh", "-c", line], { cwd: dir, stderr: "pipe" });
      expect(await proc.exited, await new Response(proc.stderr).text()).toBe(0);
      const summary = await readFile(join(dir, "summary.json"), "utf8");
      expect(JSON.parse(summary)).toMatchObject({ stack: "zone", add: 1, change: 1, destroy: 1 });
      expect(summary).not.toContain(CANARY);
    },
  );
});

describe("the guard of a DNS apply, as the runner's shell runs it", () => {
  const sh = Bun.which("sh");
  const jq = Bun.which("jq");
  let dir: string;
  const files = (name: string) => join(dir, name);
  const FAKE_DNSCONTROL = `#!/bin/sh
echo "dnscontrol $* says ${CANARY}"
case "$1" in
  check) exit 0 ;;
  preview) [ -n "$FAKE_FAIL_PREVIEW" ] && exit 1; [ "$2" = "--report" ] && cp "$FAKE_REPORT" "$3"; exit 0 ;;
  push) [ -n "$FAKE_FAIL_PUSH" ] && exit 1; touch "$FAKE_PUSHED"; exit 0 ;;
esac
`;
  const FAKE_WGET = `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -O) out="$2"; shift ;; esac; shift; done
cp "$FAKE_PLANNED" "$out"
`;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "orch-dns-apply-"));
    await mkdir(files("bin"));
    await writeFile(files("bin/dnscontrol"), FAKE_DNSCONTROL, { mode: 0o755 });
    await writeFile(files("bin/wget"), FAKE_WGET, { mode: 0o755 });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const report = (details: string[]) =>
    JSON.stringify([
      {
        domain: "example.test",
        corrections: details.length,
        correction_details: details,
        provider: "bind",
      },
    ]);
  const WWW = `+ CREATE www.example.test A 192.0.2.1 ttl=300`;
  const TXT = `- DELETE _x.example.test TXT "${CANARY}" ttl=300`;

  /** Runs the generated apply script in a fresh workspace: `planned` is what the plan job saved, `now` what preview reports. */
  async function run(planned: string, now: string, env: Record<string, string> = {}) {
    const work = await mkdtemp(join(dir, "work-"));
    await mkdir(join(work, "dns"));
    await writeFile(join(work, "dns/creds.json"), '{"bind": {"directory": "zones"}}');
    await writeFile(join(work, "planned.json"), planned);
    await writeFile(join(work, "now.json"), now);
    const script = (
      (jobsOf(generatePipeline(apply()))["apply:zone"] as Job).script as string[]
    ).join("\n");
    const proc = Bun.spawn(["sh", "-e", "-c", script], {
      cwd: work,
      env: {
        PATH: `${files("bin")}:${process.env.PATH}`,
        FAKE_PLANNED: join(work, "planned.json"),
        FAKE_REPORT: join(work, "now.json"),
        FAKE_PUSHED: join(work, "pushed"),
        CI_API_V4_URL: "https://gitlab.example.com/api/v4",
        CI_PROJECT_ID: "42",
        CI_JOB_TOKEN: "job-token",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return {
      code: await proc.exited,
      said: out + err,
      pushed: await Bun.file(join(work, "pushed")).exists(),
      saved: await Bun.file(join(work, "dns/preview.txt"))
        .text()
        .catch(() => ""),
    };
  }

  const ready = !!sh && !!jq;

  test.skipIf(!ready)(
    "the same change set pushes, in whatever order the tool reports it",
    async () => {
      const r = await run(report([WWW, TXT]), report([TXT, WWW]));
      expect(r).toMatchObject({ code: 0, pushed: true, said: "" });
      // the tool's own words are in the artifact, not in the log
      expect(r.saved).toContain(CANARY);
    },
  );

  test.skipIf(!ready)(
    "a record whose value changed since the plan is not pushed, and the log says so without the value",
    async () => {
      const r = await run(
        report([WWW]),
        report([`+ CREATE www.example.test A 192.0.2.99 ttl=300`]),
      );
      expect(r.code).toBe(1);
      expect(r.pushed).toBe(false);
      expect(r.said).toBe(
        "the zone's changes are not the ones that were planned: nothing was pushed. Plan again.\n",
      );
      expect(r.said).not.toContain("192.0.2");
    },
  );

  test.skipIf(!ready)(
    "a change that was not in the plan, or one that went away, is not pushed",
    async () => {
      for (const [planned, now] of [
        [report([WWW]), report([WWW, TXT])],
        [report([WWW, TXT]), report([WWW])],
        [report([WWW]), report([])],
      ]) {
        const r = await run(planned as string, now as string);
        expect([r.code, r.pushed]).toEqual([1, false]);
      }
    },
  );

  test.skipIf(!ready)(
    "a plan report that cannot be read stops the job: an empty set is not a match",
    async () => {
      for (const planned of ["", "not json", "{}"]) {
        const r = await run(planned, report([]));
        expect([planned, r.code !== 0, r.pushed]).toEqual([planned, true, false]);
      }
    },
  );

  test.skipIf(!ready)(
    "a failed preview or push says only the fixed words, and nothing is pushed after a failed preview",
    async () => {
      const preview = await run(report([WWW]), report([WWW]), { FAKE_FAIL_PREVIEW: "1" });
      expect([preview.code, preview.pushed]).toEqual([1, false]);
      expect(preview.said).toBe(
        "dnscontrol failed; its output is the preview.txt artifact, which developers can read\n",
      );
      const push = await run(report([WWW]), report([WWW]), { FAKE_FAIL_PUSH: "1" });
      expect(push.code).toBe(1);
      expect(push.said).toBe(
        "dnscontrol push failed; its output is the push.txt artifact, which developers can read\n",
      );
      expect(preview.said + push.said).not.toContain(CANARY);
    },
  );
});

// DNS-9: a manual job that reads the zones a stack's dnsconfig.js points at from their providers and keeps the draft
const IMAGES = { dnscontrol: "registry.example.com/orch/dnscontrol" };
const importPlan = (over: Partial<PlanInput> = {}) => plan({ images: IMAGES, ...over });

describe("the import job of a DNS zone (DNS-9)", () => {
  test("snapshot", () => {
    expect(generatePipeline(importPlan())).toMatchSnapshot();
  });

  test("is manual, never blocks the pipeline, waits for nothing, and its artifact is for developers", () => {
    const jobs = jobsOf(generatePipeline(importPlan()));
    const job = jobs["import:zone"] as Job;
    expect(job).toMatchObject({
      // in the stack's own stage: the plan job's
      stage: jobs["plan:zone"]?.stage,
      when: "manual",
      allow_failure: true,
      needs: [],
      interruptible: true,
      image: { name: "registry.example.com/orch/dnscontrol:5.5.0", entrypoint: [""] },
      artifacts: {
        paths: ["dns/import/", "dns/import.log"],
        expire_in: "1 week",
        access: "developer",
        when: "always",
      },
    });
    expect(job.script[0]).toBe("cd dns");
    // nothing waits for it: the summary and apply of the zone need the plan job only
    expect(JSON.stringify(jobs["summary:zone"]?.needs)).not.toContain("import");
  });

  test("reads only: it never pushes, previews or checks, and never fetches from the network", () => {
    const run = (
      (jobsOf(generatePipeline(importPlan()))["import:zone"] as Job).script as string[]
    ).join("\n");
    expect(run).toContain("dnscontrol get-zones --format=js");
    expect(run).not.toMatch(/dnscontrol (push|preview|check)|--allow-fetch/);
  });

  test("with an environment the zones are read through orch, after signing in and checking the credentials", () => {
    const job = jobsOf(generatePipeline(withEnvironment()))["import:zone"] as Job;
    expect(job.script.slice(1, 3)).toEqual(['login="$(orch ci login)"', 'eval "$login"']);
    expect(job.script.join("\n")).toContain("orch run -- dnscontrol get-zones --format=js");
    expect(job.script.join("\n")).toContain("creds.json names");
    expect(job.environment).toEqual({ name: "dns", action: "access" });
  });

  test("only where there is an image with jq in it: none without the custom image, none for Terraform, none for an apply", () => {
    expect(jobsOf(generatePipeline(plan()))["import:zone"]).toBeUndefined();
    const terraform = plan({
      stacks: [
        zone({ name: "net", path: "net", tool: "terraform", version: "1.9.0", backend: "http" }),
      ],
      select: ["net"],
      images: IMAGES,
    });
    expect(Object.keys(jobsOf(generatePipeline(terraform)))).not.toContain("import:net");
    expect(jobsOf(generatePipeline(apply()))["import:zone"]).toBeUndefined();
  });

  test("a stack in the repository's root keeps its files at the root", () => {
    const job = jobsOf(generatePipeline(importPlan({ stacks: [zone({ path: "." })] })))[
      "import:zone"
    ] as Job;
    expect(job.artifacts.paths).toEqual(["import/", "import.log"]);
    expect(job.script[0]).not.toContain("cd ");
  });
});

describe("the import job, as the runner's shell runs it", () => {
  const sh = Bun.which("sh");
  const jq = Bun.which("jq");
  const ready = !!sh && !!jq;
  let dir: string;
  const files = (name: string) => join(dir, name);
  const FAKE_DNSCONTROL = `#!/bin/sh
case "$1" in
  print-ir) [ -n "$FAKE_FAIL_IR" ] && { echo "line 3: ${CANARY}" >&2; exit 1; }; cat "$FAKE_IR"; exit 0 ;;
  get-zones)
    for a in "$@"; do case "$a" in --out=*) out="\${a#--out=}" ;; esac; done
    echo "$@" >> "$FAKE_CALLS"
    echo "dnscontrol $* says ${CANARY}"
    [ -n "$FAKE_FAIL_GET" ] && exit 1
    cp "$FAKE_DRAFT" "$out"; exit 0 ;;
esac
`;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "orch-dns-import-"));
    await mkdir(files("bin"));
    await writeFile(files("bin/dnscontrol"), FAKE_DNSCONTROL, { mode: 0o755 });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const irOf = (...domains: [name: string, providers: Record<string, number>][]) =>
    JSON.stringify({ domains: domains.map(([name, dnsProviders]) => ({ name, dnsProviders })) });

  /** Runs the generated script in a fresh workspace and returns what it said and what it left for the artifact. */
  async function run(ir: string, env: Record<string, string> = {}) {
    const work = await mkdtemp(join(dir, "work-"));
    await mkdir(join(work, "dns"));
    await writeFile(join(work, "ir.json"), ir);
    await writeFile(join(work, "calls"), "");
    const script = (
      (jobsOf(generatePipeline(importPlan()))["import:zone"] as Job).script as string[]
    ).join("\n");
    // creds.json names no variable, so the credentials check has nothing to find
    await writeFile(join(work, "dns/creds.json"), '{"bind": {"TYPE": "BIND"}}');
    const proc = Bun.spawn(["sh", "-e", "-c", script], {
      cwd: work,
      env: {
        PATH: `${files("bin")}:${process.env.PATH}`,
        FAKE_IR: join(work, "ir.json"),
        FAKE_DRAFT: fixture("get-zones.js"),
        FAKE_CALLS: join(work, "calls"),
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const read = (p: string) =>
      readFile(join(work, "dns", p), "utf8").catch(() => undefined) as Promise<string | undefined>;
    return {
      code: await proc.exited,
      said: out + err,
      calls: (await readFile(join(work, "calls"), "utf8")).trim().split("\n").filter(Boolean),
      draft: await read("import/example.test.js"),
      log: await read("import.log"),
      left: (await readdir(join(work, "dns/import")).catch(() => [])).sort(),
    };
  }

  test.skipIf(!ready)(
    "writes one draft per zone, with the provider call fixed and NO_PURGE added, and says nothing itself",
    async () => {
      const r = await run(irOf(["example.test", { bind: -1 }]));
      expect(r).toMatchObject({ code: 0, said: "", left: ["example.test.js"] });
      expect(r.calls).toEqual([
        `get-zones --format=js --out=import/example.test.raw bind example.test`,
      ]);
      const draft = r.draft as string;
      expect(draft).toContain('var DSP_BIND = NewDnsProvider("bind");');
      expect(draft).not.toContain('NewDnsProvider("bind", "")');
      // NO_PURGE comes right after the D( line, once, and the records of the draft are as the tool wrote them
      expect(draft).toContain('D("example.test", REG_CHANGEME,\n\tNO_PURGE,\n\t{no_ns: "true"},');
      expect(draft.match(/NO_PURGE/g)).toHaveLength(1);
      expect(draft).toContain('TXT("_canary", "CANARY-VALUE-7f3a")');
      // the tool's own words are in the artifact, not in the log
      expect(r.log).toContain(CANARY);
    },
  );

  test.skipIf(!ready)(
    "a zone with several providers is read from the first, one call per zone",
    async () => {
      const r = await run(irOf(["a.test", { first: -1, second: -1 }], ["b.test", { bind: -1 }]));
      expect(r.code).toBe(0);
      expect(r.calls).toEqual([
        "get-zones --format=js --out=import/a.test.raw first a.test",
        "get-zones --format=js --out=import/b.test.raw bind b.test",
      ]);
    },
  );

  test.skipIf(!ready)(
    "a name that is not a zone name or a provider key that is not one is skipped, never passed to a shell",
    async () => {
      const r = await run(
        irOf(
          ["example.test", { bind: -1 }],
          ["$(touch pwned).test", { bind: -1 }],
          ["Evil.test", { bind: -1 }],
          ["a b.test", { bind: -1 }],
          ["bad-key.test", { "x;touch pwned": -1 }],
          ["no-provider.test", {}],
          // a trailing newline would pass a `$`, and a key that starts with a dash would be an option
          ["newline.test\n", { bind: -1 }],
          ["option.test", { "--creds": -1 }],
        ),
      );
      expect(r.code).toBe(0);
      expect(r.calls).toEqual([
        "get-zones --format=js --out=import/example.test.raw bind example.test",
      ]);
      expect(await Bun.file(files("pwned")).exists()).toBe(false);
    },
  );

  test.skipIf(!ready)("no zone with a provider is one fixed message and a failure", async () => {
    const r = await run(irOf(["no-provider.test", {}]));
    expect(r.code).toBe(1);
    expect(r.said).toBe("dnsconfig.js declares no zone with a provider to import from\n");
    expect(r.calls).toEqual([]);
  });

  test.skipIf(!ready)(
    "a config that does not evaluate, and a provider that refuses, say only fixed words: the tool's go to the artifact",
    async () => {
      const config = await run(irOf(["example.test", { bind: -1 }]), { FAKE_FAIL_IR: "1" });
      expect(config.code).toBe(1);
      expect(config.said).toBe(
        "dnscontrol could not read dnsconfig.js; its output is the import.log artifact, which developers can read\n",
      );
      expect(config.log).toContain(CANARY);
      const get = await run(irOf(["example.test", { bind: -1 }]), { FAKE_FAIL_GET: "1" });
      expect(get.code).toBe(1);
      expect(get.said).toBe(
        "dnscontrol get-zones failed; its output is the import.log artifact, which developers can read\n",
      );
      expect(get.log).toContain(CANARY);
      expect(config.said + get.said).not.toContain(CANARY);
    },
  );

  test.skipIf(!ready)(
    "one zone failing does not stop the others being read, and the job still fails",
    async () => {
      // the fake fails every get-zones: the point is that every zone was tried
      const r = await run(irOf(["a.test", { bind: -1 }], ["b.test", { bind: -1 }]), {
        FAKE_FAIL_GET: "1",
      });
      expect(r.code).toBe(1);
      expect(r.calls).toHaveLength(2);
    },
  );
});

// The round trip of the task's "done when", against the real tool: the imported draft, planned against the zone it
// was read from, is no change. Opt in with the path of a dnscontrol binary: DNSCONTROL_BIN=/path/to/dnscontrol bun test
describe("the import job against the real dnscontrol (DNS-9)", () => {
  const bin = process.env.DNSCONTROL_BIN;
  const ready = !!bin && !!Bun.which("sh") && !!Bun.which("jq");

  test.skipIf(!ready)(
    "the draft it keeps, planned against the same BIND zone, is an empty plan",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-dns-real-"));
      try {
        await mkdir(join(root, "bin"));
        await symlink(bin as string, join(root, "bin/dnscontrol"));
        await mkdir(join(root, "dns/zones"), { recursive: true });
        await copyFile(fixture("get-zones.zone"), join(root, "dns/zones/example.test.zone"));
        await copyFile(fixture("creds.json"), join(root, "dns/creds.json"));
        // what `orch dns init` writes: the zone and its provider, no records
        await writeFile(
          join(root, "dns/dnsconfig.js"),
          'var REG = NewRegistrar("none");\nvar DNS = NewDnsProvider("bind");\nD("example.test", REG, DnsProvider(DNS), NO_PURGE);\n',
        );
        const sh = async (script: string) => {
          const proc = Bun.spawn(["sh", "-e", "-c", script], {
            cwd: root,
            env: { PATH: `${join(root, "bin")}:${process.env.PATH}` },
            stdout: "pipe",
            stderr: "pipe",
          });
          const [out, err] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          return { code: await proc.exited, said: out + err };
        };
        const script = (
          (jobsOf(generatePipeline(importPlan()))["import:zone"] as Job).script as string[]
        ).join("\n");
        expect(await sh(script)).toEqual({ code: 0, said: "" });
        // the draft replaces the scaffold, as a developer would commit it
        await copyFile(join(root, "dns/import/example.test.js"), join(root, "dns/dnsconfig.js"));
        expect(await sh("cd dns && dnscontrol check")).toEqual({
          code: 0,
          said: expect.any(String),
        });
        expect((await sh("cd dns && dnscontrol preview --report report.json")).code).toBe(0);
        const report = JSON.parse(await readFile(join(root, "dns/report.json"), "utf8")) as {
          corrections: number;
          correction_details?: string[];
        }[];
        expect(report.map((r) => r.corrections)).toEqual(report.map(() => 0));
        expect(report.flatMap((r) => r.correction_details ?? [])).toEqual([]);
        // NO_PURGE alone would hide a draft that lists nothing: without it the draft must still be no change, so it
        // holds every record of the zone
        expect(await readFile(join(root, "dns/dnsconfig.js"), "utf8")).toContain(
          'A("www", "192.0.2.2")',
        );
        expect((await sh("cd dns && sed -i.bak '/NO_PURGE/d' dnsconfig.js")).code).toBe(0);
        expect((await sh("cd dns && dnscontrol preview --report report.json")).code).toBe(0);
        const strict = JSON.parse(await readFile(join(root, "dns/report.json"), "utf8")) as {
          corrections: number;
        }[];
        expect(strict.length).toBeGreaterThan(0);
        expect(strict.map((r) => r.corrections)).toEqual(strict.map(() => 0));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

// DNS-11: the lint of an evaluated config. The plan job keeps `print-ir` as an artifact for developers (it holds
// record values), and the summary job runs `orch dns lint` over it and adds the report to the summary it posts.
describe("the lint of a DNS zone (DNS-11)", () => {
  const sh = Bun.which("sh");
  const jq = Bun.which("jq");
  const planScript = (input = plan()) =>
    (jobsOf(generatePipeline(input))["plan:zone"] as Job).script as string[];
  const summaryScript = (input = plan()) =>
    (jobsOf(generatePipeline(input))["summary:zone"] as Job).script as string[];
  const LINT = "orch dns lint < dns/ir.json > lint.json || rm -f lint.json";

  test("the plan job evaluates the config once more, inside the group whose output goes to the artifact", () => {
    const line = planScript().find((l) => l.includes("dnscontrol preview")) as string;
    expect(line).toContain("dnscontrol print-ir > ir.json; } > preview.txt 2>&1");
    // after the preview: a config the preview refused has no evaluation to keep
    expect(line.indexOf("preview --report")).toBeLessThan(line.indexOf("print-ir"));
    // the tool's own errors still go to the file and its failure still fails the job with the fixed words
    expect(line).toContain('echo "dnscontrol failed');
    expect(planScript(withEnvironment()).join("\n")).toContain("dnscontrol print-ir > ir.json");
  });

  test("the apply does not evaluate it again: only the plan is linted", () => {
    expect(generatePipeline(apply())).not.toContain("print-ir");
  });

  test("the summary job lints between making the summary and posting it", () => {
    const script = summaryScript();
    const at = (needle: string) => script.findIndex((l) => l.includes(needle));
    expect(script).toContain(LINT);
    expect(at("--arg stack")).toBeLessThan(at("dns lint"));
    expect(at("dns lint")).toBeLessThan(at("--slurpfile lint"));
    expect(at("--slurpfile lint")).toBeLessThan(at("curl "));
    // it runs where orch is
    expect((jobsOf(generatePipeline(plan()))["summary:zone"] as Job).image.name).toBe(
      "registry.example.com/orch/ci-helper:1.0.0",
    );
  });

  test("a stack that prunes says so: a zone that purges is then what it asked for", () => {
    expect(summaryScript(plan({ stacks: [zone({ dnsPrune: true })] }))).toContain(
      "orch dns lint --prune < dns/ir.json > lint.json || rm -f lint.json",
    );
    for (const dnsPrune of [false, undefined]) {
      expect(summaryScript(plan({ stacks: [zone({ dnsPrune })] })).join("\n")).not.toContain(
        "--prune",
      );
    }
  });

  test("a Terraform stack's jobs know nothing of it", () => {
    const tf: Stack = {
      ...zone(),
      name: "net",
      path: "net",
      tool: "terraform",
      version: "1.9.8",
      backend: "http",
    };
    const jobs = jobsOf(generatePipeline(plan({ stacks: [tf], select: ["net"] })));
    expect(JSON.stringify(jobs)).not.toMatch(/dns lint|print-ir|ir\.json/);
  });

  describe("as the runner's shell runs it", () => {
    let dir: string;
    // a stand-in for orch: `dns lint` prints FAKE_LINT (or fails), and says what it was called with
    const FAKE_ORCH = `#!/bin/sh
echo "orch $*" >> "$FAKE_CALLS"
[ "$1 $2" = "dns lint" ] || exit 9
[ -n "$FAKE_FAIL_LINT" ] && { echo "error: stdin is not the output of dnscontrol print-ir" >&2; exit 1; }
cat > "$FAKE_STDIN"
printf '%s' "$FAKE_LINT"
`;
    const REPORT = {
      errors: 1,
      warnings: 0,
      findings: [{ rule: "spf-single", severity: "error", address: "z.test/@/TXT" }],
    };
    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "orch-dns-lint-"));
      await mkdir(join(dir, "bin"));
      await mkdir(join(dir, "dns"));
      await writeFile(join(dir, "bin/orch"), FAKE_ORCH, { mode: 0o755 });
      await writeFile(join(dir, "dns/report.json"), await readFile(fixture("report-changes.json")));
    });
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    // the summary job's lines up to the post: the login and the curl are the platform's
    const lines = (input = plan()) =>
      summaryScript(input).filter(
        (l) => !l.startsWith("login=") && !l.startsWith("eval ") && !l.startsWith("curl "),
      );
    async function run(env: Record<string, string>, input = plan(), withIr = true) {
      await rm(join(dir, "summary.json"), { force: true });
      await rm(join(dir, "lint.json"), { force: true });
      await rm(join(dir, "calls"), { force: true });
      if (withIr) await writeFile(join(dir, "dns/ir.json"), `{"ir": "${CANARY}"}`);
      else await rm(join(dir, "dns/ir.json"), { force: true });
      const proc = Bun.spawn(["sh", "-c", lines(input).join("\n")], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          FAKE_CALLS: join(dir, "calls"),
          FAKE_STDIN: join(dir, "stdin"),
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return {
        code,
        said: out + err,
        summary: JSON.parse(await readFile(join(dir, "summary.json"), "utf8")),
        calls: (await readFile(join(dir, "calls"), "utf8").catch(() => "")).trim(),
        stdin: await readFile(join(dir, "stdin"), "utf8").catch(() => ""),
      };
    }

    test.skipIf(!sh || !jq)(
      "the report rides on the summary, beside the counts, and lint read the plan job's file",
      async () => {
        const r = await run({ FAKE_LINT: JSON.stringify(REPORT) });
        expect(r.code).toBe(0);
        expect(r.summary).toMatchObject({
          stack: "zone",
          add: 1,
          change: 1,
          destroy: 1,
          lint: REPORT,
        });
        expect(r.calls).toBe("orch dns lint");
        expect(r.stdin).toBe(`{"ir": "${CANARY}"}`);
        // what the job says is nothing, and no value is in what it posts
        expect(r.said).toBe("");
        expect(JSON.stringify(r.summary)).not.toContain(CANARY);
      },
    );

    test.skipIf(!sh || !jq)("--prune reaches the command when the stack prunes", async () => {
      const r = await run(
        { FAKE_LINT: JSON.stringify(REPORT) },
        plan({ stacks: [zone({ dnsPrune: true })] }),
      );
      expect(r.calls).toBe("orch dns lint --prune");
    });

    test.skipIf(!sh || !jq)(
      "a report with no finding is still posted: it says the lint ran",
      async () => {
        const none = { errors: 0, warnings: 0, findings: [] };
        expect((await run({ FAKE_LINT: JSON.stringify(none) })).summary.lint).toEqual(none);
      },
    );

    test.skipIf(!sh || !jq)(
      "a lint that fails leaves the summary as it was, the log says the command's fixed words, and the job goes on",
      async () => {
        const r = await run({ FAKE_FAIL_LINT: "1" });
        expect(r.code).toBe(0);
        expect(r.summary).toMatchObject({ stack: "zone", add: 1 });
        expect(r.summary.lint).toBeUndefined();
        // the job log says the command's fixed words and nothing of the config
        expect(r.said).toBe("error: stdin is not the output of dnscontrol print-ir\n");
        expect(r.said).not.toContain(CANARY);
      },
    );

    test.skipIf(!sh || !jq)(
      "no ir.json (a plan job from before the lint) and an answer that is not JSON both leave the summary as it was",
      async () => {
        const missing = await run({ FAKE_LINT: JSON.stringify(REPORT) }, plan(), false);
        expect([missing.code, missing.summary.lint]).toEqual([0, undefined]);
        const junk = await run({ FAKE_LINT: "not json" });
        expect([junk.code, junk.summary.lint]).toEqual([0, undefined]);
        expect(junk.summary).toMatchObject({ stack: "zone", add: 1 });
      },
    );
  });

  const bin = process.env.DNSCONTROL_BIN;
  test.skipIf(!bin || !sh || !jq)(
    "the generated plan line, run with the real dnscontrol, leaves an evaluation the lint reads",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "orch-dns-real-lint-"));
      try {
        await mkdir(join(root, "bin"));
        await symlink(bin as string, join(root, "bin/dnscontrol"));
        await mkdir(join(root, "dns/zones"), { recursive: true });
        await copyFile(fixture("get-zones.zone"), join(root, "dns/zones/example.test.zone"));
        await copyFile(fixture("creds.json"), join(root, "dns/creds.json"));
        // two SPF records on one name: what `dnscontrol check` accepts and the lint refuses
        await writeFile(
          join(root, "dns/dnsconfig.js"),
          [
            'var REG = NewRegistrar("none");',
            'var DNS = NewDnsProvider("bind");',
            `D("example.test", REG, DnsProvider(DNS), NO_PURGE, TXT("@", "v=spf1 -all"), TXT("@", "v=spf1 include:${CANARY}.test -all"));`,
            "",
          ].join("\n"),
        );
        const script = planScript().slice(1).join("\n");
        const proc = Bun.spawn(["sh", "-e", "-c", `cd dns\n${script}`], {
          cwd: root,
          env: { PATH: `${join(root, "bin")}:${process.env.PATH}` },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect([await proc.exited, out + err]).toEqual([0, ""]);
        const ir = JSON.parse(await readFile(join(root, "dns/ir.json"), "utf8"));
        const report = lintReport(lintZones(ir, { prune: false }));
        expect(report.findings).toContainEqual({
          rule: "spf-single",
          severity: "error",
          address: "example.test/@/TXT",
        });
        expect(JSON.stringify(report)).not.toContain(CANARY);
        // the value is in the evaluation the developers keep, and nowhere the platform reads
        expect(JSON.stringify(ir)).toContain(CANARY);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
