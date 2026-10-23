import { z } from "zod";
import { MAX_ZONE, ZONE } from "./stack";

/**
 * The platform's own checks of a DNS config (DNS-10), on top of DNSControl's `check`, which accepts what these
 * refuse (two SPF records on a name, for one). They read the evaluated config, the output of `dnscontrol
 * print-ir`, and give findings: a rule, a severity and an address (`<zone>`, or `<zone>/<name>/<TYPE>` as a plan's
 * summary has it). A finding never carries a record's value, so it can go anywhere a summary goes.
 */
export const LINT_RULES = {
  spfSingle: "spf-single",
  dmarcWithMx: "dmarc-with-mx",
  caaApex: "caa-apex",
  ttlRange: "ttl-range",
  keepUnknown: "keep-unknown",
} as const;
export type LintRule = (typeof LINT_RULES)[keyof typeof LINT_RULES];
export type LintSeverity = "error" | "warn";
export type LintFinding = { rule: LintRule; severity: LintSeverity; address: string };

/** An `error` denies an apply (DNS-11); a `warn` is shown on the merge request and nothing more. */
const SEVERITY: Record<LintRule, LintSeverity> = {
  "spf-single": "error",
  "dmarc-with-mx": "warn",
  "caa-apex": "warn",
  "ttl-range": "warn",
  "keep-unknown": "error",
};
export const MIN_TTL = 60;
export const MAX_TTL = 86400;

export class LintInputError extends Error {
  constructor() {
    super("not the output of dnscontrol print-ir");
  }
}

// only what the rules read; `.nullish()` because the tool prints `null` for a list or flag it has none of
const irSchema = z.object({
  domains: z.array(
    z.object({
      name: z.string(),
      keepunknown: z.boolean().nullish(),
      records: z
        .array(
          z.object({
            type: z.string(),
            name: z.string(),
            ttl: z.number().nullish(),
            rdata: z.record(z.string(), z.unknown()).nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

// shortcut: the records of DNSControl 5 (`rdata`); an older version's have none, so for them the TXT and MX rules see
// no records. Upgrade when a stack on a version before 5 needs them.
const txtOf = (rdata: Record<string, unknown> | null | undefined) =>
  Array.isArray(rdata?.Txt) ? rdata.Txt.filter((s) => typeof s === "string").join("") : "";

/**
 * Findings for every zone in a `print-ir` document, in the order the config has its zones, and within a zone by
 * rule. `prune` is the stack's `dns.prune`: a zone that purges what it does not list is only what was asked for
 * when the stack prunes. A zone whose name is not a plain zone name (a split-horizon `zone!view`) is not read,
 * and a document that is not a `print-ir` is refused, not taken for a clean one.
 */
export function lintZones(ir: unknown, { prune }: { prune: boolean }): LintFinding[] {
  const parsed = irSchema.safeParse(ir);
  if (!parsed.success) throw new LintInputError();
  const findings: LintFinding[] = [];
  for (const zone of parsed.data.domains) {
    if (zone.name.length > MAX_ZONE || !ZONE.test(zone.name)) continue;
    const at = zone.name;
    const records = zone.records ?? [];
    const add = (rule: LintRule, address: string) =>
      findings.push({ rule, severity: SEVERITY[rule], address });

    // one SPF record per name
    const spf = new Map<string, number>();
    for (const r of records)
      if (r.type === "TXT" && /^v=spf1\b/i.test(txtOf(r.rdata)))
        spf.set(r.name, (spf.get(r.name) ?? 0) + 1);
    for (const [name, count] of spf) if (count > 1) add(LINT_RULES.spfSingle, `${at}/${name}/TXT`);

    // a name that takes mail has a DMARC record: its own, or the zone's at the apex, which covers its subdomains
    const dmarc = new Set(
      records
        .filter((r) => r.type === "TXT" && /^v=DMARC1\b/i.test(txtOf(r.rdata)))
        .map((r) => r.name),
    );
    const mail = new Set(
      records.filter((r) => r.type === "MX" && r.rdata?.Mx !== ".").map((r) => r.name),
    );
    for (const name of mail)
      if (!dmarc.has("_dmarc") && !dmarc.has(name === "@" ? "_dmarc" : `_dmarc.${name}`))
        add(LINT_RULES.dmarcWithMx, `${at}/${name}/MX`);

    if (!records.some((r) => r.type === "CAA" && r.name === "@"))
      add(LINT_RULES.caaApex, `${at}/@/CAA`);

    const ttl = new Set(
      records
        .filter((r) => typeof r.ttl === "number" && (r.ttl < MIN_TTL || r.ttl > MAX_TTL))
        .map((r) => `${at}/${r.name}/${r.type}`),
    );
    for (const address of ttl) add(LINT_RULES.ttlRange, address);

    if (!prune && !zone.keepunknown) add(LINT_RULES.keepUnknown, at);
  }
  return findings;
}

// shortcut: a summary lists at most 500 findings (the counts are whole); the plan-summary route refuses more, so raise both together.
export const MAX_LINT_FINDINGS = 500;

export interface LintReport {
  errors: number;
  warnings: number;
  /** The errors first, then the warnings, each in the order found; at most `MAX_LINT_FINDINGS`. */
  findings: LintFinding[];
}

/** The block a plan's summary carries (DNS-11): whole counts, and a list that never cuts an error for a warning. */
export function lintReport(findings: readonly LintFinding[]): LintReport {
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warn");
  return {
    errors: errors.length,
    warnings: warnings.length,
    findings: [...errors, ...warnings].slice(0, MAX_LINT_FINDINGS),
  };
}
