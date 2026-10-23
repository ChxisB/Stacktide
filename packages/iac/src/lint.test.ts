import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LINT_RULES,
  type LintFinding,
  LintInputError,
  lintReport,
  lintZones,
  MAX_LINT_FINDINGS,
} from "./lint";

// DNS-10: the platform's own checks of a DNS config, on top of DNSControl's `check`. They read the evaluated config
// (`dnscontrol print-ir`), so a fixture is what the real tool printed for fixtures/dnscontrol/lint.js.
const CANARY = "CANARY-VALUE-7f3a";
const read = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures/dnscontrol", name), "utf8"));
const IR = read("lint.json");
const only = (zone: string) => ({
  domains: IR.domains.filter((d: { name: string }) => d.name === zone),
});
const found = (zone: string, prune = false) => lintZones(only(zone), { prune });

describe("a zone every rule is happy with", () => {
  test("has no finding", () => {
    expect(found("good.test")).toEqual([]);
  });
});

describe("spf-single", () => {
  test("two SPF records on one name are one error at that name, which `dnscontrol check` accepts", () => {
    expect(found("spf.test")).toEqual([
      { rule: LINT_RULES.spfSingle, severity: "error", address: "spf.test/@/TXT" },
    ]);
  });

  test("one SPF record, and other TXT records, are fine; so is an SPF on each of two names", () => {
    const txt = (name: string, ...strings: string[]) => ({
      type: "TXT",
      name,
      ttl: 300,
      rdata: { Txt: strings },
    });
    const ir = {
      domains: [
        {
          name: "a.test",
          keepunknown: true,
          records: [
            txt("@", "v=spf1 -all"),
            txt("@", "google-site-verification=abc"),
            txt("mail", "v=spf1 -all"),
            txt("_caa", "no"),
          ],
        },
      ],
    };
    expect(lintZones(ir, { prune: false }).filter((f) => f.rule === LINT_RULES.spfSingle)).toEqual(
      [],
    );
  });

  test("an SPF record is found in any case and when its text is split into strings", () => {
    const txt = (...strings: string[]) => ({
      type: "TXT",
      name: "@",
      ttl: 300,
      rdata: { Txt: strings },
    });
    const ir = {
      domains: [
        {
          name: "a.test",
          keepunknown: true,
          records: [txt("V=SPF1 ", "-all"), txt("v=spf1", " a -all")],
        },
      ],
    };
    expect(lintZones(ir, { prune: false }).map((f) => f.rule)).toContain(LINT_RULES.spfSingle);
  });

  test("a TXT that only mentions v=spf1 is not an SPF record", () => {
    const ir = {
      domains: [
        {
          name: "a.test",
          keepunknown: true,
          records: [
            { type: "TXT", name: "@", ttl: 300, rdata: { Txt: ["v=spf1 -all"] } },
            { type: "TXT", name: "@", ttl: 300, rdata: { Txt: ["note: v=spf1 is above"] } },
            { type: "TXT", name: "@", ttl: 300, rdata: { Txt: ["v=spf10 -all"] } },
          ],
        },
      ],
    };
    expect(lintZones(ir, { prune: false }).map((f) => f.rule)).not.toContain(LINT_RULES.spfSingle);
  });
});

describe("dmarc-with-mx", () => {
  test("a name that takes mail, in a zone with no DMARC record, is a warning for each such name", () => {
    expect(found("dmarc.test")).toEqual([
      { rule: LINT_RULES.dmarcWithMx, severity: "warn", address: "dmarc.test/@/MX" },
      { rule: LINT_RULES.dmarcWithMx, severity: "warn", address: "dmarc.test/lists/MX" },
    ]);
  });

  test("a DMARC record at the zone's apex covers its subdomains; one at the name itself covers that name", () => {
    const dmarc = (name: string) => ({
      type: "TXT",
      name,
      ttl: 300,
      rdata: { Txt: ["v=DMARC1; p=none"] },
    });
    const mx = (name: string) => ({
      type: "MX",
      name,
      ttl: 300,
      rdata: { Preference: 10, Mx: "mail.a.test." },
    });
    const caa = { type: "CAA", name: "@", ttl: 300, rdata: { Flag: 0, Tag: "issue", Value: "x" } };
    const zone = (...records: object[]) => ({
      domains: [{ name: "a.test", keepunknown: true, records: [caa, ...records] }],
    });
    expect(lintZones(zone(mx("@"), mx("lists"), dmarc("_dmarc")), { prune: false })).toEqual([]);
    expect(lintZones(zone(mx("lists"), dmarc("_dmarc.lists")), { prune: false })).toEqual([]);
    expect(lintZones(zone(mx("lists"), dmarc("_dmarc.other")), { prune: false })).toHaveLength(1);
  });

  test("a name that says it takes no mail (a null MX, RFC 7505) needs none", () => {
    const ir = {
      domains: [
        {
          name: "a.test",
          keepunknown: true,
          records: [
            { type: "MX", name: "@", ttl: 300, rdata: { Preference: 0, Mx: "." } },
            { type: "CAA", name: "@", ttl: 300, rdata: { Flag: 0, Tag: "issue", Value: "x" } },
          ],
        },
      ],
    };
    expect(lintZones(ir, { prune: false })).toEqual([]);
  });
});

describe("caa-apex", () => {
  test("a zone with no CAA record at its apex is a warning", () => {
    expect(found("caa.test")).toEqual([
      { rule: LINT_RULES.caaApex, severity: "warn", address: "caa.test/@/CAA" },
    ]);
  });

  test("a CAA record below the apex is not one at the apex", () => {
    const ir = {
      domains: [
        {
          name: "a.test",
          keepunknown: true,
          records: [
            { type: "CAA", name: "www", ttl: 300, rdata: { Flag: 0, Tag: "issue", Value: "x" } },
          ],
        },
      ],
    };
    expect(lintZones(ir, { prune: false }).map((f) => f.rule)).toEqual([LINT_RULES.caaApex]);
  });
});

describe("ttl-range", () => {
  test("a TTL under 60 seconds or over a day is a warning at its record; the bounds themselves are fine", () => {
    expect(found("ttl.test")).toEqual([
      { rule: LINT_RULES.ttlRange, severity: "warn", address: "ttl.test/short/A" },
      { rule: LINT_RULES.ttlRange, severity: "warn", address: "ttl.test/long/A" },
    ]);
  });
});

describe("keep-unknown", () => {
  test("a zone that purges what it does not list, in a stack that does not prune, is an error on the zone", () => {
    expect(found("purge.test")).toEqual([
      { rule: LINT_RULES.keepUnknown, severity: "error", address: "purge.test" },
    ]);
  });

  test("not when the stack prunes: the purge is then what it asked for", () => {
    expect(found("purge.test", true)).toEqual([]);
  });

  test("a zone that keeps what it does not list is fine either way", () => {
    expect(found("good.test", true)).toEqual([]);
    expect(found("good.test", false)).toEqual([]);
  });
});

describe("the whole fixture", () => {
  test("every finding of every zone, zones in the order the config has them", () => {
    expect(
      lintZones(IR, { prune: false }).map((f) => `${f.severity} ${f.rule} ${f.address}`),
    ).toEqual([
      "error spf-single spf.test/@/TXT",
      "warn dmarc-with-mx dmarc.test/@/MX",
      "warn dmarc-with-mx dmarc.test/lists/MX",
      "warn caa-apex caa.test/@/CAA",
      "warn ttl-range ttl.test/short/A",
      "warn ttl-range ttl.test/long/A",
      "error keep-unknown purge.test",
    ]);
  });

  test("a finding is a rule, a severity and an address: no value, whatever the records hold", () => {
    const findings = lintZones(IR, { prune: false });
    expect(JSON.stringify(findings)).not.toContain(CANARY);
    for (const f of findings)
      expect(Object.keys(f).sort()).toEqual(["address", "rule", "severity"]);
    // the canary is in the config: in a TXT value of a zone with no finding, and inside an SPF record of one with
    expect(JSON.stringify(IR)).toContain(CANARY);
  });

  test("a document that is not a print-ir has no findings to give: it is refused, not read as clean", () => {
    for (const bad of [null, "x", [], {}, { domains: "x" }, { domains: [{ records: [] }] }]) {
      expect(() => lintZones(bad, { prune: false })).toThrow(LintInputError);
    }
    expect(() => lintZones({ domains: [] }, { prune: false })).not.toThrow();
  });

  test("a zone whose name is not a plain zone name is not read, so its text goes nowhere", () => {
    const ir = {
      domains: [
        { name: "a b.test", records: [] },
        { name: "good.test!internal", records: [] },
        { name: "<script>.test", records: [] },
      ],
    };
    expect(lintZones(ir, { prune: false })).toEqual([]);
  });
});

describe("the report that goes into a plan's summary (DNS-11)", () => {
  const f = (rule: LintFinding["rule"], severity: LintFinding["severity"], address: string) => ({
    rule,
    severity,
    address,
  });

  test("counts of both severities, and the findings with the errors first, each kept in order", () => {
    const warn1 = f("ttl-range", "warn", "a.test/x/A");
    const error1 = f("spf-single", "error", "a.test/@/TXT");
    const warn2 = f("caa-apex", "warn", "a.test/@/CAA");
    const error2 = f("keep-unknown", "error", "b.test");
    expect(lintReport([warn1, error1, warn2, error2])).toEqual({
      errors: 2,
      warnings: 2,
      findings: [error1, error2, warn1, warn2],
    });
  });

  test("no finding is a report with zero counts: it says the lint ran", () => {
    expect(lintReport([])).toEqual({ errors: 0, warnings: 0, findings: [] });
  });

  test("the list is cut at the bound, the counts stay whole, and no error is cut for a warning", () => {
    const warns = Array.from({ length: MAX_LINT_FINDINGS + 5 }, (_, i) =>
      f("ttl-range", "warn", `a.test/n${i}/A`),
    );
    const error = f("spf-single", "error", "a.test/@/TXT");
    const report = lintReport([...warns, error]);
    expect(report.errors).toBe(1);
    expect(report.warnings).toBe(MAX_LINT_FINDINGS + 5);
    expect(report.findings).toHaveLength(MAX_LINT_FINDINGS);
    expect(report.findings[0]).toEqual(error);
  });

  test("the whole fixture: what the zones' findings come to", () => {
    const report = lintReport(lintZones(IR, { prune: false }));
    expect([report.errors, report.warnings, report.findings.length]).toEqual([2, 5, 7]);
    expect(JSON.stringify(report)).not.toContain(CANARY);
  });
});
