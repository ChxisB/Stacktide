/** A line of a plan, as far as the strip needs it: where it goes and what it does. */
export interface FlowLine {
  scope: string;
  action: string;
}

const WORDS = [
  ["create", "to create"],
  ["update", "to change"],
  ["delete", "to delete"],
] as const;
/** "2 to create, 1 to change": only what is not zero, in the words the card already uses. Empty when nothing is written. */
const parts = (lines: readonly FlowLine[]) =>
  WORDS.map(([action, word]) => [lines.filter((l) => l.action === action).length, word] as const)
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(", ");

/**
 * Where a target's variables go (FLW-5): the project's variables, a line for each mapped environment, the
 * target. With a plan open each line says what the plan does for its scope, and a plan line for a scope no
 * environment maps to is counted on the target, so none is lost. Read-only. The strip is words in boxes
 * and rules (nothing to hide from a screen reader), and a target with no mapping has none.
 */
export function SyncFlow({
  project,
  target,
  mapping,
  lines,
}: {
  project: string;
  target: { name: string; type: string };
  mapping: Record<string, string>;
  lines?: readonly FlowLine[];
}) {
  const environments = Object.entries(mapping).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (environments.length === 0) return null;
  const mapped = new Set(Object.values(mapping));
  const everywhere = lines?.filter((l) => l.scope === "*") ?? [];
  const elsewhere = parts(lines?.filter((l) => l.scope !== "*" && !mapped.has(l.scope)) ?? []);
  const line = (own: readonly FlowLine[]) => parts(own) || "Nothing to change";
  return (
    <div className="sync-flow">
      <div className="sync-box">
        <span className="muted">Variables</span>
        <span className="sync-name">{project}</span>
      </div>
      <ul className="sync-lines">
        {everywhere.length > 0 && (
          <li>
            <span>All environments</span>
            <span className="muted">{line(everywhere)}</span>
          </li>
        )}
        {environments.map(([slug, scope]) => (
          <li key={slug}>
            <span>{`${slug} → ${scope}`}</span>
            {lines && <span className="muted">{line(lines.filter((l) => l.scope === scope))}</span>}
          </li>
        ))}
      </ul>
      <div className="sync-box sync-target">
        <span className="muted">{target.type}</span>
        <span className="sync-name">{target.name}</span>
        {elsewhere && <span className="muted">{`Other scopes: ${elsewhere}`}</span>}
      </div>
    </div>
  );
}
