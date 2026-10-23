import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  LintInputError,
  lintReport,
  lintZones,
  MAX_ZONE,
  NAME,
  parseManifest,
  SLUG,
  VERSION,
  ZONE,
} from "@orch/iac";
import { CliError, type Command, parse, say } from "./cli";

const USAGE = [
  "usage: orch dns init <directory> --zone <zone> --provider <TYPE> [--name <stack>] [--version <dnscontrol>] [--environment <slug>]",
  "       orch dns lint [--prune] < print-ir.json",
].join("\n");
// the version the platform's DNS spike was run against (docs/dns-spike.md); the image tag of the stack's jobs
const DNSCONTROL_VERSION = "5.5.0";
// DNSControl names its provider types in capitals (CLOUDFLAREAPI, ROUTE53, AZURE_DNS)
const PROVIDER = /^[A-Z][A-Z0-9_]{1,39}$/;
// Providers whose credential fields were checked in DNSControl's own documentation. Any other gets its type
// only: guessing a field name would write a creds.json the provider ignores.
const SECRETS: Record<string, Record<string, string>> = {
  CLOUDFLAREAPI: { apitoken: "CF_API_TOKEN" },
  ROUTE53: { KeyId: "AWS_ACCESS_KEY_ID", SecretKey: "AWS_SECRET_ACCESS_KEY" },
};

/**
 * `orch dns init <directory> --zone <zone> --provider <TYPE>` writes the three files of a DNS zone stack (DNS-8):
 * `stack.yml`, `dnsconfig.js` and `creds.json`. The zone is kept as it is at the provider: `NO_PURGE` makes
 * DNSControl leave the records the file does not list, which is the default the platform's delete gate
 * (`dns.prune`) expects. `creds.json` holds `$NAME` references to variables and never a value. It writes
 * nothing when any of the three exists.
 */
export function dnsCommands(): Record<string, Command> {
  return {
    dns: {
      summary:
        "DNS zone stacks: orch dns init <directory> --zone <zone> --provider <TYPE>; orch dns lint < print-ir.json",
      async run(ctx, args) {
        const { values, positionals } = parse(args, {
          zone: { type: "string" },
          provider: { type: "string" },
          name: { type: "string" },
          version: { type: "string" },
          environment: { type: "string" },
          prune: { type: "boolean" },
        });
        const [verb, directory, ...extra] = positionals;
        if (verb === "lint") {
          const init = [
            values.zone,
            values.provider,
            values.name,
            values.version,
            values.environment,
          ];
          if (positionals.length > 1 || init.some((v) => v !== undefined)) {
            throw new CliError(USAGE, 2);
          }
          return lint(ctx, values.prune === true);
        }
        if (
          verb !== "init" ||
          !directory ||
          extra.length > 0 ||
          !values.zone ||
          !values.provider ||
          values.prune
        ) {
          throw new CliError(USAGE, 2);
        }
        // every value ends up in YAML, JavaScript or JSON text, so each is checked before it is written, and
        // none is echoed back
        const { zone, provider } = values;
        const name = values.name ?? zone.replaceAll(".", "-");
        const version = values.version ?? DNSCONTROL_VERSION;
        const bad = (option: string, rule: string) => {
          throw new CliError(`--${option} ${rule}`, 2);
        };
        if (zone.length > MAX_ZONE || !ZONE.test(zone))
          bad("zone", "is not a zone name: lowercase labels like example.com");
        if (!PROVIDER.test(provider))
          bad("provider", "is not a DNSControl provider type: capitals, like CLOUDFLAREAPI");
        if (!NAME.test(name))
          bad("name", "is not a stack name: lowercase letters, digits and dashes");
        if (!VERSION.test(version)) bad("version", "must look like 5.5.0 (no v, no range)");
        if (values.environment !== undefined && !SLUG.test(values.environment))
          bad(
            "environment",
            "is not an environment slug: lowercase letters and digits, single dashes",
          );

        const manifest = [
          `name: ${name}`,
          "tool: dnscontrol",
          `version: ${version}`,
          ...(values.environment === undefined ? [] : [`environment: ${values.environment}`]),
          "",
        ].join("\n");
        // the platform's own schema has the last word on what is written
        const checked = parseManifest(manifest);
        if (!checked.ok)
          throw new CliError(
            `the stack.yml would not be accepted: ${checked.errors.join("; ")}`,
            2,
          );

        const key = provider.toLowerCase();
        const fields = SECRETS[provider] ?? {};
        const creds = {
          [key]: {
            TYPE: provider,
            ...Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, `$${v}`])),
          },
        };
        const config = [
          'var REG = NewRegistrar("none");',
          `var DNS = NewDnsProvider(${JSON.stringify(key)});`,
          "// NO_PURGE keeps the records the provider has and this file does not list. Take it out only together",
          "// with `dns: {prune: true}` in stack.yml: with it gone, a plan deletes what is not listed.",
          `D(${JSON.stringify(zone)}, REG, DnsProvider(DNS), NO_PURGE`,
          "  // the zone's records go here",
          ");",
          "",
        ].join("\n");

        const out = [
          ["stack.yml", manifest],
          ["dnsconfig.js", config],
          ["creds.json", `${JSON.stringify(creds, null, 2)}\n`],
        ] as const;
        const dir = resolve(ctx.cwd, directory);
        // all of them are looked for before one is written, so a refusal leaves the directory as it was
        for (const [file] of out) {
          if (await Bun.file(join(dir, file)).exists())
            throw new CliError(`${join(directory, file)} exists already; nothing was written`);
        }
        await mkdir(dir, { recursive: true });
        // flag "wx": a file that appeared since the check is not overwritten either
        for (const [file, text] of out) {
          try {
            await writeFile(join(dir, file), text, { flag: "wx" });
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST")
              throw new CliError(`${join(directory, file)} exists already; it was not overwritten`);
            throw e;
          }
        }

        const variables = Object.values(fields);
        const lines = [
          `wrote ${out.map(([f]) => join(directory, f)).join(", ")}`,
          "records the file does not list are kept (NO_PURGE); add the zone's records to dnsconfig.js",
          variables.length > 0
            ? `create these as secret variables: ${variables.join(", ")}`
            : `add ${provider}'s fields to creds.json, each as a "$NAME" reference, and create a secret variable for each $NAME`,
          values.environment === undefined
            ? "set environment: <slug> in stack.yml to the environment that holds them, or the job does not get them"
            : `create them in the environment ${values.environment}`,
        ];
        say(ctx, lines.join("\n"), {
          stack: name,
          directory,
          files: out.map(([f]) => f),
          variables,
        });
      },
    },
  };
}

/**
 * `orch dns lint [--prune]` (DNS-11): the platform's checks of a DNS config, over the `dnscontrol print-ir` on stdin.
 * Prints the report the plan's summary carries as one JSON document, and exits 0 whatever it finds: what an
 * `error` finding means is for the platform to say, at the apply. The words of a refusal are fixed; the input holds
 * record values and is never echoed.
 */
async function lint(ctx: Parameters<Command["run"]>[0], prune: boolean) {
  let ir: unknown;
  try {
    ir = JSON.parse(await ctx.stdin());
  } catch {
    ir = undefined;
  }
  try {
    ctx.io.out(JSON.stringify(lintReport(lintZones(ir, { prune }))));
  } catch (e) {
    if (e instanceof LintInputError)
      throw new CliError("stdin is not the output of dnscontrol print-ir");
    throw e;
  }
}
