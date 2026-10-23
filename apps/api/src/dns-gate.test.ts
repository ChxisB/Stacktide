import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judge, POLICY_RULE } from "@orch/core";
import type { LintFinding } from "@orch/iac";
import { DNS_RULES, dnsVerdict, zonesOf } from "./dns-gate";

const rec = (address: string, ...actions: string[]) => ({ address, actions });
const plan = (resources: ReturnType<typeof rec>[], over: { destroy?: number } = {}) => {
  const count = (a: string) => resources.filter((r) => r.actions.includes(a)).length;
  return {
    add: count("create"),
    change: count("update"),
    destroy: over.destroy ?? count("delete"),
    resources,
  };
};
const denied = (
  p: ReturnType<typeof plan>,
  { prune = false, claimed = [] as string[] }: { prune?: boolean; claimed?: string[] } = {},
) => judge(dnsVerdict(p, { prune, claimed: new Set(claimed) })).denied;

describe("which zones a plan names", () => {
  test("the first part of each address, once, in order; a zone with no records is its own address", () => {
    expect(
      zonesOf([
        rec("b.example/www/A", "create"),
        rec("a.example/@/TXT", "update"),
        rec("b.example/_dmarc/TXT", "create"),
        rec("c.example", "create"),
      ]),
    ).toEqual(["a.example", "b.example", "c.example"]);
    expect(zonesOf([])).toEqual([]);
  });
});

describe("a zone the stack has claimed", () => {
  test("passes when it changes records and deletes none", () => {
    const p = plan([rec("a.example/www/A", "create"), rec("a.example/@/MX", "update")]);
    expect(denied(p, { claimed: ["a.example"] })).toEqual([]);
  });

  test("a plan with no changes names no zone and passes", () => {
    expect(denied(plan([]))).toEqual([]);
  });
});

describe("a zone the stack has not claimed", () => {
  test("is denied by name, once however many records change", () => {
    const p = plan([rec("a.example/www/A", "create"), rec("a.example/api/A", "create")]);
    expect(denied(p)).toEqual([`${DNS_RULES.unclaimed}:a.example`]);
  });

  test("only the zone that is not claimed", () => {
    const p = plan([rec("a.example/www/A", "create"), rec("b.example/www/A", "create")]);
    expect(denied(p, { claimed: ["a.example"] })).toEqual([`${DNS_RULES.unclaimed}:b.example`]);
  });

  test("prune does not make it allowed", () => {
    const p = plan([rec("a.example/old/A", "delete")]);
    expect(denied(p, { prune: true })).toEqual([`${DNS_RULES.unclaimed}:a.example`]);
  });
});

describe("a plan that deletes records", () => {
  const p = plan([rec("a.example/old/A", "delete"), rec("a.example/www/A", "create")]);

  test("is denied by zone while the stack does not prune", () => {
    expect(denied(p, { claimed: ["a.example"] })).toEqual([`${DNS_RULES.delete}:a.example`]);
  });

  test("is allowed when the stack prunes", () => {
    expect(denied(p, { prune: true, claimed: ["a.example"] })).toEqual([]);
  });

  test("a delete in one zone names that zone only", () => {
    const two = plan([rec("a.example/old/A", "delete"), rec("b.example/www/A", "create")]);
    expect(denied(two, { claimed: ["a.example", "b.example"] })).toEqual([
      `${DNS_RULES.delete}:a.example`,
    ]);
  });

  test("a delete the list does not show (the count says so) is denied without a zone", () => {
    const hidden = { add: 1, change: 0, destroy: 1, resources: [rec("a.example/www/A", "create")] };
    expect(denied(hidden, { claimed: ["a.example"] })).toEqual([
      DNS_RULES.delete,
      DNS_RULES.truncated,
    ]);
  });
});

describe("a plan whose list is shorter than its counts", () => {
  test("is denied: the zones it leaves out cannot be checked", () => {
    const cut = { add: 3, change: 0, destroy: 0, resources: [rec("a.example/www/A", "create")] };
    expect(denied(cut, { claimed: ["a.example"] })).toEqual([DNS_RULES.truncated]);
  });
});

describe("what the rule names may hold", () => {
  test("a zone that is not a zone is one fixed rule, and its text is nowhere in it", () => {
    const text = ["Evil.example", "evil zone.example", "<script>.example", "*.example", ""];
    const p = plan(text.map((z) => rec(`${z}/www/A`, "create")));
    const names = denied(p);
    expect(names).toEqual([DNS_RULES.invalid]);
    expect(JSON.stringify(names)).not.toContain("script");
    expect(JSON.stringify(names)).not.toContain("Evil");
  });

  test("a record's name never appears, only the zone's", () => {
    const p = plan([rec("a.example/_canary-secret/TXT", "delete")]);
    const names = denied(p, { claimed: ["a.example"] });
    expect(names).toEqual([`${DNS_RULES.delete}:a.example`]);
    expect(JSON.stringify(names)).not.toContain("canary");
  });

  test("every name is a policy rule name; a zone too long for one is left out of it", () => {
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example`;
    const p = plan([rec("a.example/www/A", "create"), rec(`${long}/www/A`, "create")]);
    const names = denied(p);
    expect(names).toEqual([`${DNS_RULES.unclaimed}:a.example`, DNS_RULES.unclaimed]);
    for (const n of names) expect(POLICY_RULE.test(n)).toBe(true);
  });

  test("at most fifty, as many as a posted verdict may carry", () => {
    const many = Array.from({ length: 60 }, (_, i) => rec(`z${i}.example/www/A`, "create"));
    expect(denied(plan(many))).toHaveLength(50);
  });
});

// DNS-11: what the lint of a zone's config adds to the verdict
describe("the lint of a zone (DNS-11)", () => {
  const finding = (
    rule: LintFinding["rule"],
    severity: LintFinding["severity"],
    address: string,
  ): LintFinding => ({ rule, severity, address });
  const lint = (findings: LintFinding[], over: { errors?: number } = {}) => ({
    errors: over.errors ?? findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warn").length,
    findings,
  });
  const judged = (l: ReturnType<typeof lint>, claimed = ["a.example"]) =>
    judge(dnsVerdict(plan([]), { prune: false, claimed: new Set(claimed), lint: l }));

  test("an error finding denies by rule and zone, and a plan with no change at all is still judged", () => {
    const r = judged(lint([finding("spf-single", "error", "a.example/@/TXT")]));
    expect(r).toEqual({ verdict: "deny", denied: ["dns-lint-spf-single:a.example"], warned: [] });
  });

  test("a warning is shown and does not deny", () => {
    const r = judged(lint([finding("ttl-range", "warn", "a.example/www/A")]));
    expect(r).toEqual({ verdict: "warn", denied: [], warned: ["dns-lint-ttl-range:a.example"] });
  });

  test("a rule is named once per zone, however many names in it break it", () => {
    const r = judged(
      lint([
        finding("ttl-range", "warn", "a.example/a/A"),
        finding("ttl-range", "warn", "a.example/b/A"),
        finding("ttl-range", "warn", "b.example/a/A"),
      ]),
    );
    expect(r.warned).toEqual(["dns-lint-ttl-range:a.example", "dns-lint-ttl-range:b.example"]);
  });

  test("a zone-wide finding (an address that is the bare zone) names the zone", () => {
    expect(judged(lint([finding("keep-unknown", "error", "a.example")])).denied).toEqual([
      "dns-lint-keep-unknown:a.example",
    ]);
  });

  test("it does not need a claim: it adds to the claim's and the delete rule's denials and does not replace them", () => {
    const withDelete = plan([rec("a.example/old/A", "delete")]);
    const r = judge(
      dnsVerdict(withDelete, {
        prune: false,
        claimed: new Set(),
        lint: lint([finding("spf-single", "error", "a.example/@/TXT")]),
      }),
    );
    expect(r.denied).toEqual([
      `${DNS_RULES.unclaimed}:a.example`,
      `${DNS_RULES.delete}:a.example`,
      "dns-lint-spf-single:a.example",
    ]);
  });

  test("an error the list does not show (the count says so) is denied: the list is cut, the counts are whole", () => {
    const r = judged(lint([finding("spf-single", "error", "a.example/@/TXT")], { errors: 3 }));
    expect(r.denied).toEqual(["dns-lint-spf-single:a.example", DNS_RULES.lintTruncated]);
    // errors the list shows are not a truncation
    expect(judged(lint([finding("spf-single", "error", "a.example/@/TXT")])).denied).not.toContain(
      DNS_RULES.lintTruncated,
    );
  });

  test("an address with no zone in it is one fixed rule, and its text is nowhere in the names", () => {
    const r = judged(
      lint([
        finding("spf-single", "error", "Evil <b>zone</b>/@/TXT"),
        finding("ttl-range", "warn", "evil zone/www/A"),
      ]),
    );
    expect(r.denied).toEqual([DNS_RULES.invalid]);
    expect(r.warned).toEqual([DNS_RULES.invalid]);
    expect(JSON.stringify(r)).not.toMatch(/Evil|evil/);
  });

  test("a record's name never appears, only the zone's", () => {
    const r = judged(
      lint([
        finding("spf-single", "error", "a.example/_canary-secret/TXT"),
        finding("ttl-range", "warn", "a.example/_canary-secret/A"),
      ]),
    );
    expect(JSON.stringify(r)).not.toContain("canary");
  });

  test("every name is a policy rule name, and at most fifty of each kind", () => {
    const many = Array.from({ length: 60 }, (_, i) => `z${i}.example`);
    const r = dnsVerdict(plan([]), {
      prune: false,
      claimed: new Set(many),
      lint: lint([
        ...many.map((z) => finding("spf-single", "error", `${z}/@/TXT`)),
        ...many.map((z) => finding("ttl-range", "warn", `${z}/www/A`)),
      ]),
    });
    expect(r.denied).toHaveLength(50);
    expect(r.warned).toHaveLength(50);
    for (const n of [...r.denied, ...r.warned]) expect(POLICY_RULE.test(n)).toBe(true);
  });

  test("with no lint block the verdict is the claims' and the delete rule's alone", () => {
    expect(judge(dnsVerdict(plan([]), { prune: false, claimed: new Set() }))).toEqual({
      verdict: "pass",
      denied: [],
      warned: [],
    });
  });
});

// DNS-14: the reasons docs/dns.md tells a reader to look for are the ones a denial carries
describe("docs/dns.md", () => {
  test("names every fixed reason of the gate", () => {
    const doc = readFileSync(join(import.meta.dir, "../../../docs/dns.md"), "utf8");
    for (const reason of Object.values(DNS_RULES)) expect(doc).toContain(`\`${reason}`);
  });
});
