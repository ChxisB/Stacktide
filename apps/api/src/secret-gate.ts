import { judge, type SecretGate, secretGateVerdict } from "@orch/core";
import { countOpenFindings, type Executor, getSecretGate } from "@orch/db";

export interface SecretGateView {
  gate: SecretGate;
  /** Open findings seen on the project's default branch; not counted (0) when the gate is off. */
  open: number;
  denied: string[];
  warned: string[];
}

/** What the organization's secret gate says of a project now (SCAN-6): the setting, the count it judges and the verdict. */
export async function secretGateOf(
  db: Executor,
  scope: { organizationId: string; projectId: string },
): Promise<SecretGateView> {
  const gate = (await getSecretGate(db, scope.organizationId)) ?? "off";
  const open = gate === "off" ? 0 : await countOpenFindings(db, scope);
  const { denied, warned } = judge(secretGateVerdict(gate, open));
  return { gate, open, denied, warned };
}
