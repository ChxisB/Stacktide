/** A report larger than this (in characters) is refused unread: GitLab's own are far smaller. */
export const MAX_REPORT_BYTES = 5 * 1024 * 1024;
/** More findings than this is a report to look at, not to store. */
export const MAX_REPORT_FINDINGS = 1000;

export const FINDING_SEVERITIES = ["info", "unknown", "low", "medium", "high", "critical"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** `open` needs a look; `dismissed` was judged not a problem by a person; `resolved` is gone from the default branch. */
export const FINDING_STATUSES = ["open", "dismissed", "resolved"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * What the platform keeps of one finding. Nothing of the secret is here and nothing derived from it: GitLab's
 * report has a `raw_source_code_extract` (an unsanitized excerpt) and free text in `description`, `details`,
 * `solution` and the commit message, and none of those is read.
 */
export interface ParsedFinding {
  /** GitLab's id for the finding: what the next report is matched against. */
  fingerprint: string;
  /** The analyzer's rule (`aws-access-token`), or `unknown` when it is not of that shape. */
  rule: string;
  path: string;
  line: number | null;
  commit: string;
  severity: FindingSeverity;
}

export type SecretReport =
  | {
      ok: true;
      findings: ParsedFinding[];
      /** Entries that lacked what a finding needs, or were not objects. */
      skipped: number;
      /**
       * The scan finished and looked at everything: only then does a finding missing from this report mean it is
       * gone. A failed scan, a partial (differential) one, or a report with no scan block says nothing about the rest.
       */
      complete: boolean;
    }
  | { ok: false; reason: "malformed" | "too_large" | "too_many" };

const refuse = (reason: "malformed" | "too_large" | "too_many") => ({ ok: false, reason }) as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// what the table's integer column holds: a line beyond it would fail the insert of the whole report
const MAX_LINE = 2_147_483_647;
const FINGERPRINT = /^[A-Za-z0-9_.:-]{1,100}$/;
const RULE = /^[a-z][a-z0-9-]{0,99}$/;
const SHA = /^[0-9a-f]{7,64}$/i;
// a path as GitLab reports it: no control characters
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point of the check
const PATH = /^[^\u0000-\u001f\u007f]{1,1024}$/;

const severityOf = (v: unknown): FindingSeverity => {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return (FINDING_SEVERITIES as readonly string[]).includes(s) ? (s as FindingSeverity) : "unknown";
};

/** The `gitleaks_rule_id` identifier, else the first one: the rule's name, never the finding's value. */
function ruleOf(identifiers: unknown): string {
  if (!Array.isArray(identifiers)) return "unknown";
  const named = identifiers.filter(isObject);
  const pick = named.find((i) => i.type === "gitleaks_rule_id") ?? named[0];
  const value = pick?.value;
  return typeof value === "string" && RULE.test(value) ? value : "unknown";
}

function findingOf(raw: unknown): ParsedFinding | undefined {
  if (!isObject(raw)) return undefined;
  const { id, location } = raw;
  if (typeof id !== "string" || !FINGERPRINT.test(id) || !isObject(location)) return undefined;
  const { file, start_line: line, commit } = location;
  const sha = isObject(commit) ? commit.sha : undefined;
  if (typeof file !== "string" || !PATH.test(file)) return undefined;
  if (typeof sha !== "string" || !SHA.test(sha)) return undefined;
  return {
    fingerprint: id,
    rule: ruleOf(raw.identifiers),
    path: file,
    line:
      typeof line === "number" && Number.isInteger(line) && line > 0 && line <= MAX_LINE
        ? line
        : null,
    commit: sha.toLowerCase(),
    severity: severityOf(raw.severity),
  };
}

/**
 * Reads GitLab's secret-detection report (`gl-secret-detection-report.json`) by an **allowlist**: each
 * finding is built from named fields, the input is never spread or copied, so a field a later GitLab
 * adds cannot reach a row. Every failure is a reason and not a throw, and no reason carries the text.
 * shortcut: the size is counted in characters (the fetch caps bytes); the finding id's uniqueness across
 * scans is GitLab's word, not checked against a real report.
 */
export function parseSecretReport(text: string): SecretReport {
  if (text.length > MAX_REPORT_BYTES) return refuse("too_large");
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return refuse("malformed");
  }
  if (!isObject(doc) || !Array.isArray(doc.vulnerabilities)) return refuse("malformed");
  if (doc.vulnerabilities.length > MAX_REPORT_FINDINGS) return refuse("too_many");

  const found = new Map<string, ParsedFinding>();
  let skipped = 0;
  for (const raw of doc.vulnerabilities) {
    const f = findingOf(raw);
    if (!f) skipped++;
    else if (!found.has(f.fingerprint)) found.set(f.fingerprint, f);
  }
  const scan = doc.scan;
  const complete = isObject(scan) && scan.status === "success" && scan.partial_scan === undefined;
  return { ok: true, findings: [...found.values()], skipped, complete };
}
