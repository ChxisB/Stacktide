import type { DetectedType } from "@orch/core";
import { byVersion, type Template } from "./loader";

export interface Recommendation {
  template: string;
  /** The newest version in the catalog. */
  version: string;
  /** The surest of the kinds the template suits that the project looks like. */
  confidence: DetectedType["confidence"];
  /** Which kinds and the files that showed them, e.g. `bun (bun.lock)`. */
  reason: string;
}

const SURER = { high: 0, medium: 1 } as const;

/**
 * Templates that suit a project, from the kinds `detectProjectTypes` found in it (PIPE-4): the newest
 * version of each template whose `detects` names one of them, the surest first and then by name.
 * A project that looks like nothing the catalog knows (Terraform today, or an empty repository) gets none.
 */
export function recommend(
  detected: readonly DetectedType[],
  catalog: readonly Template[],
): Recommendation[] {
  const newest = new Map<string, Template["manifest"]>();
  for (const { manifest } of [...catalog].sort((a, b) =>
    byVersion(a.manifest.version, b.manifest.version),
  ))
    newest.set(manifest.name, manifest);
  return [...newest.values()]
    .flatMap((manifest) => {
      const hits = detected.filter((d) => manifest.detects.includes(d.tag));
      if (hits.length === 0) return [];
      return [
        {
          template: manifest.name,
          version: manifest.version,
          confidence: hits.some((h) => h.confidence === "high")
            ? ("high" as const)
            : ("medium" as const),
          reason: hits.map((h) => `${h.tag} (${h.evidence.join(", ")})`).join("; "),
        },
      ];
    })
    .sort(
      (a, b) => SURER[a.confidence] - SURER[b.confidence] || (a.template < b.template ? -1 : 1),
    );
}
