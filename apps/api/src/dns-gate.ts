import type { PolicyReport } from "@orch/core";
import { type LintFinding, MAX_ZONE, ZONE } from "@orch/iac";

/** The rules a DNS plan can be denied by; they travel like a policy rule's name, in the same lists. */
export const DNS_RULES = {
  unclaimed: "dns-zone-unclaimed",
  delete: "dns-delete-without-prune",
  invalid: "dns-zone-invalid",
  truncated: "dns-plan-truncated",
  lintTruncated: "dns-lint-truncated",
} as const;

/** What the lint of the zone's config said (DNS-11): the whole count of errors, and the findings as far as they were listed. */
export interface DnsLint {
  errors: number;
  findings: readonly LintFinding[];
}

interface DnsPlan {
  add: number;
  change: number;
  destroy: number;
  resources: readonly { address: string; actions: readonly string[] }[];
}

// at most what a posted policy verdict may carry
const MAX_RULES = 50;
// the longest name a policy rule may have (`POLICY_RULE` in core)
const MAX_RULE = 200;

const zoneOf = (r: DnsPlan["resources"][number]) => r.address.split("/", 1)[0] ?? "";

/** The zones a plan changes: the first part of each `<zone>/<name>/<TYPE>` address (or the bare `<zone>`), once, in order. */
export const zonesOf = (resources: DnsPlan["resources"]) =>
  [...new Set(resources.map(zoneOf))].sort();

// A zone is named only when it is one (the job's text is not echoed) and the name fits a rule name.
const named = (rule: string, zone: string) =>
  `${rule}:${zone}`.length <= MAX_RULE ? `${rule}:${zone}` : rule;

/**
 * What the claims and the prune setting make of a zone's plan (DNS-7), as a policy report so it is
 * judged and shown like one: a zone the stack has not claimed, a delete while the stack does not
 * `prune`, and a list too short to check (the counts are whole, the list is cut). The lint of the config
 * (DNS-11) adds a rule and a zone for each of its findings: an `error` denies, a `warn` is shown. The names
 * hold the zone and never a record's name or value. `claimed` is what `claimedZones` found for the stack.
 */
export function dnsVerdict(
  plan: DnsPlan,
  {
    prune,
    claimed,
    lint,
  }: { prune: boolean; claimed: ReadonlySet<string>; lint?: DnsLint | undefined },
): PolicyReport {
  const denied: string[] = [];
  const warned: string[] = [];
  const deletes = plan.resources.filter((r) => r.actions.includes("delete"));
  for (const zone of zonesOf(plan.resources)) {
    if (!ZONE.test(zone) || zone.length > MAX_ZONE) {
      if (!denied.includes(DNS_RULES.invalid)) denied.push(DNS_RULES.invalid);
      continue;
    }
    if (!claimed.has(zone)) denied.push(named(DNS_RULES.unclaimed, zone));
    if (!prune && deletes.some((r) => zoneOf(r) === zone)) {
      denied.push(named(DNS_RULES.delete, zone));
    }
  }
  // a delete the list does not show: the count says there is one
  if (!prune && plan.destroy > 0 && deletes.length === 0) denied.push(DNS_RULES.delete);
  if (plan.resources.length < plan.add + plan.change + plan.destroy) {
    denied.push(DNS_RULES.truncated);
  }
  if (lint) {
    for (const f of lint.findings) {
      const zone = f.address.split("/", 1)[0] ?? "";
      const name =
        !ZONE.test(zone) || zone.length > MAX_ZONE
          ? DNS_RULES.invalid
          : named(`dns-lint-${f.rule}`, zone);
      const into = f.severity === "error" ? denied : warned;
      if (!into.includes(name)) into.push(name);
    }
    // an error the list does not show: the count says there is one
    if (lint.errors > lint.findings.filter((f) => f.severity === "error").length) {
      denied.push(DNS_RULES.lintTruncated);
    }
  }
  return {
    evaluated: true,
    denied: denied.slice(0, MAX_RULES),
    warned: warned.slice(0, MAX_RULES),
  };
}
