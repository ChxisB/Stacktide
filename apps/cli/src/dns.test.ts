import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LINT_RULES, parseManifest, ZONE } from "@orch/iac";
import { runCli } from "./cli";
import { dnsCommands } from "./dns";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "orch-dns-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function orch(argv: string[], stdin = "") {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    env: {},
    cwd: dir,
    home: dir,
    stdin: async () => stdin,
    open: async () => {},
    confirm: async () => true,
    version: "0.0.0",
    commands: dnsCommands(),
  });
  return { code, out, err, text: out.join("\n") };
}
const read = (...p: string[]) => readFile(join(dir, ...p), "utf8");
const files = async (d: string) => (await readdir(join(dir, d)).catch(() => [])).sort();

let n = 0;
const fresh = () => `stacks/dns-${++n}`;
const init = (target: string, ...more: string[]) =>
  orch(["dns", "init", target, "--zone", "example.com", "--provider", "CLOUDFLAREAPI", ...more]);

describe("orch dns init", () => {
  test("writes the three files; the stack.yml passes the platform's schema as a zone with no pruning", async () => {
    const d = fresh();
    const r = await init(d, "--name", "example-com");
    expect(r).toMatchObject({ code: 0, err: [] });
    expect(await files(d)).toEqual(["creds.json", "dnsconfig.js", "stack.yml"]);
    const parsed = parseManifest(await read(d, "stack.yml"));
    expect(parsed).toMatchObject({
      ok: true,
      manifest: { name: "example-com", tool: "dnscontrol", version: "5.5.0" },
    });
    if (parsed.ok) expect(parsed.manifest.dns?.prune).toBeUndefined();
  });

  test("dnsconfig.js keeps the records it does not list (NO_PURGE) and lists none of its own", async () => {
    const d = fresh();
    await init(d);
    const js = await read(d, "dnsconfig.js");
    expect(js).toContain('D("example.com", REG, DnsProvider(DNS), NO_PURGE');
    expect(js).toContain('NewDnsProvider("cloudflareapi")');
    expect(js).not.toMatch(/\b(A|AAAA|CNAME|MX|TXT)\(/);
  });

  test("creds.json holds the provider and a $NAME for every secret, never a value", async () => {
    const d = fresh();
    const r = await init(d);
    expect(JSON.parse(await read(d, "creds.json"))).toEqual({
      cloudflareapi: { TYPE: "CLOUDFLAREAPI", apitoken: "$CF_API_TOKEN" },
    });
    expect(r.text).toContain("CF_API_TOKEN");
    const route53 = fresh();
    await orch(["dns", "init", route53, "--zone", "example.com", "--provider", "ROUTE53"]);
    expect(JSON.parse(await read(route53, "creds.json"))).toEqual({
      route53: {
        TYPE: "ROUTE53",
        KeyId: "$AWS_ACCESS_KEY_ID",
        SecretKey: "$AWS_SECRET_ACCESS_KEY",
      },
    });
  });

  test("a provider it does not know gets the type only, and is told to add its own $NAME fields", async () => {
    const d = fresh();
    const r = await orch(["dns", "init", d, "--zone", "example.com", "--provider", "NS1"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(await read(d, "creds.json"))).toEqual({ ns1: { TYPE: "NS1" } });
    expect(r.text).toContain("$NAME");
  });

  test("--environment goes into the stack.yml; without one the output says the variables will not reach the job", async () => {
    const withEnv = fresh();
    await init(withEnv, "--environment", "production");
    expect(await read(withEnv, "stack.yml")).toContain("environment: production");
    const without = await init(fresh());
    expect(without.text).toContain("environment");
  });

  test("an existing file is never overwritten, and nothing else is written either", async () => {
    const d = fresh();
    await mkdir(join(dir, d), { recursive: true });
    await writeFile(join(dir, d, "dnsconfig.js"), "// mine\n");
    const r = await init(d);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("dnsconfig.js");
    expect(await read(d, "dnsconfig.js")).toBe("// mine\n");
    expect(await files(d)).toEqual(["dnsconfig.js"]);
    // and a second run over a finished scaffold changes nothing
    const done = fresh();
    await init(done);
    const before = await read(done, "creds.json");
    expect((await init(done, "--provider", "ROUTE53")).code).not.toBe(0);
    expect(await read(done, "creds.json")).toBe(before);
  });

  test("a provider name, zone, stack name, version or environment that is not one is a usage error that writes nothing", async () => {
    const bad: [string, string[]][] = [
      ["provider in lower case", ["--provider", "cloudflare"]],
      ["provider with a space", ["--provider", "CLOUD FLARE"]],
      ["provider with a quote", ["--provider", 'X"Y']],
      ["a zone with a capital", ["--zone", "Example.com"]],
      ["a wildcard zone", ["--zone", "*.example.com"]],
      ["a zone with a quote", ["--zone", 'a".example.com']],
      ["a stack name with a space", ["--name", "my zone"]],
      ["a version with a v", ["--version", "v5.5.0"]],
      ["an environment with a capital", ["--environment", "Prod"]],
    ];
    for (const [what, opts] of bad) {
      const d = fresh();
      const r = await orch([
        "dns",
        "init",
        d,
        "--zone",
        "example.com",
        "--provider",
        "CLOUDFLAREAPI",
        ...opts,
      ]);
      expect([what, r.code]).toEqual([what, 2]);
      expect([what, await files(d)]).toEqual([what, []]);
    }
  });

  test("needs a directory, --zone and --provider; the stack's name defaults to the zone's", async () => {
    expect(
      (await orch(["dns", "init", "--zone", "example.com", "--provider", "ROUTE53"])).code,
    ).toBe(2);
    expect((await orch(["dns", "init", fresh(), "--provider", "ROUTE53"])).code).toBe(2);
    expect((await orch(["dns", "init", fresh(), "--zone", "example.com"])).code).toBe(2);
    expect((await orch(["dns"])).code).toBe(2);
    const d = fresh();
    await orch(["dns", "init", d, "--zone", "my.example.com", "--provider", "ROUTE53"]);
    expect(await read(d, "stack.yml")).toContain("name: my-example-com");
    expect(ZONE.test("my.example.com")).toBe(true);
  });

  test("--json is one document with the files and the variable names", async () => {
    const r = await orch([
      "--json",
      "dns",
      "init",
      fresh(),
      "--zone",
      "example.com",
      "--provider",
      "ROUTE53",
    ]);
    expect(JSON.parse(r.text)).toMatchObject({
      stack: "example-com",
      files: ["stack.yml", "dnsconfig.js", "creds.json"],
      variables: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    });
  });
});

// DNS-11: the lint of an evaluated config, run by the plan's summary job over `dnscontrol print-ir`
describe("orch dns lint", () => {
  const CANARY = "CANARY-VALUE-7f3a";
  const IR = readFileSync(
    join(import.meta.dir, "../../../packages/iac/src/fixtures/dnscontrol/lint.json"),
    "utf8",
  );
  const lint = (stdin: string, ...more: string[]) => orch(["dns", "lint", ...more], stdin);

  test("reads print-ir on stdin and prints one JSON document: whole counts, the errors first", async () => {
    const r = await lint(IR);
    expect(r).toMatchObject({ code: 0, err: [] });
    expect(r.out).toHaveLength(1);
    const report = JSON.parse(r.text);
    expect([report.errors, report.warnings]).toEqual([2, 5]);
    expect(report.findings.map((f: { severity: string }) => f.severity)).toEqual([
      "error",
      "error",
      "warn",
      "warn",
      "warn",
      "warn",
      "warn",
    ]);
    expect(report.findings[0]).toEqual({
      rule: "spf-single",
      severity: "error",
      address: "spf.test/@/TXT",
    });
  });

  test("findings do not change the exit code, and no record's value is in the output", async () => {
    const r = await lint(IR);
    expect(r.code).toBe(0);
    // the canary is in the config, in a TXT value
    expect(IR).toContain(CANARY);
    expect(r.text).not.toContain(CANARY);
  });

  test("--prune is the stack's dns.prune: a zone that purges is then what was asked for", async () => {
    const report = JSON.parse((await lint(IR, "--prune")).text);
    expect([report.errors, report.warnings]).toEqual([1, 5]);
    expect(report.findings.map((f: { rule: string }) => f.rule)).not.toContain("keep-unknown");
  });

  test("a config with nothing to say is a report of zeros, not silence", async () => {
    expect(JSON.parse((await lint('{"domains":[]}')).text)).toEqual({
      errors: 0,
      warnings: 0,
      findings: [],
    });
  });

  test("input that is not print-ir is refused with fixed words, and none of it is echoed", async () => {
    for (const bad of ["", `not json ${CANARY}`, `{"domains": "${CANARY}"}`, `["${CANARY}"]`]) {
      const r = await lint(bad);
      expect(r.code).toBe(1);
      expect(r.out).toEqual([]);
      expect(r.err.join("\n")).toBe("error: stdin is not the output of dnscontrol print-ir");
    }
  });

  test("takes no directory or other word", async () => {
    expect((await lint(IR, "extra")).code).toBe(2);
    expect((await lint(IR, "--zone", "example.com")).code).toBe(2);
  });
});

// DNS-14: what docs/dns.md shows is what the CLI does
describe("docs/dns.md", () => {
  const docs = join(import.meta.dir, "../../../docs");
  const doc = readFileSync(join(docs, "dns.md"), "utf8");
  const IR = readFileSync(
    join(import.meta.dir, "../../../packages/iac/src/fixtures/dnscontrol/lint.json"),
    "utf8",
  );

  test("every `orch dns` command in its code blocks runs, with the options it shows", async () => {
    const lines = [...doc.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) =>
      (m[1] ?? "").split("\n"),
    );
    // the command after a pipe counts too (`dnscontrol print-ir | orch dns lint`); a redirect or pipe ends it
    const commands = lines.flatMap((l) => l.match(/orch dns [^|<>]*/)?.[0].trim() ?? []);
    expect(commands.filter((c) => c.startsWith("orch dns init"))).toHaveLength(1);
    expect(commands.filter((c) => c.startsWith("orch dns lint"))).toHaveLength(2);
    for (const command of commands) {
      const r = await orch(command.split(/\s+/).slice(1), IR);
      expect([command, r.code, r.err]).toEqual([command, 0, []]);
    }
  });

  test("every link to a file in the docs folder or the repository points at a file that exists", () => {
    const targets = [...doc.matchAll(/\]\(([^)\s]+)\)/g)]
      .map((m) => m[1] ?? "")
      .filter((t) => !/^[a-z]+:/.test(t));
    expect(targets).toContain("iac.md");
    for (const t of targets)
      expect([t, existsSync(join(docs, t.split("#")[0] ?? ""))]).toEqual([t, true]);
  });

  test("the pages that send readers here link to it, and every lint rule is named", () => {
    for (const from of ["README.md", "docs/iac.md"]) {
      expect(readFileSync(join(docs, "..", from), "utf8")).toMatch(/\]\((docs\/)?dns\.md\)/);
    }
    for (const rule of Object.values(LINT_RULES)) expect(doc).toContain(`\`${rule}\``);
  });
});
