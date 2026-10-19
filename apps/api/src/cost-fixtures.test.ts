import { describe, expect, test } from "bun:test";
import { type CostLimit, type CostResult, planVerdict } from "@orch/core";
import { COST_FILTER } from "@orch/iac";

// The estimator's outputs a plan job can meet (COST-6): what Infracost's JSON looks like per its
// documentation, written by hand, not captured from a real run. Each goes through the generated
// job's own jq filter (real `jq`, as the pipeline's tests do) and the verdict the apply uses.
const jq = Bun.which("jq");
const LIMIT: CostLimit = { tag: null, maxMonthlyDelta: 100, warnAt: 80, currency: "USD" };

async function estimate(fixture: string): Promise<CostResult | null> {
  const input = Bun.file(new URL(`./fixtures/cost/${fixture}.json`, import.meta.url));
  const proc = Bun.spawn([jq as string, "-e", "-c", "--arg", "tool", "infracost", COST_FILTER], {
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  // the job keeps cost.json only when jq succeeds; no output is no estimate
  return (await proc.exited) === 0 ? (JSON.parse(out) as CostResult) : null;
}

describe("fixture estimates through the plan job's filter and the verdict (COST-6)", () => {
  const cases = [
    ["small", "pass", [], [], { monthlyDelta: 12.5, monthlyTotal: 300.5 }],
    ["warn", "warn", [], ["cost-near-limit"], { monthlyDelta: 85, monthlyTotal: 1085 }],
    ["deny", "deny", ["cost-over-limit"], [], { monthlyDelta: 250.75, monthlyTotal: 1250.75 }],
    ["missing", "deny", ["cost-unavailable"], [], null],
  ] as const;

  for (const [name, verdict, denied, warned, figures] of cases) {
    test.skipIf(!jq)(
      `${name}: ${verdict} under a limit, information only without one`,
      async () => {
        const cost = await estimate(name);
        expect(cost).toEqual(figures && { ...figures, currency: "USD", tool: "infracost" });
        const judged = planVerdict(null, LIMIT, cost);
        expect([judged.verdict, judged.denied, judged.warned]).toEqual([
          verdict,
          [...denied],
          [...warned],
        ]);
        // with no limit the estimate, or the lack of one, never blocks
        expect(planVerdict(null, undefined, cost).verdict).toBe("pass");
      },
    );
  }
});
