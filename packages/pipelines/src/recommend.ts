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

/** The newest version of each template in the catalog, in the order of their names. */
export const newest = (catalog: readonly Template[]): Template["manifest"][] => {
  const byName = new Map<string, Template["manifest"]>();
  for (const { manifest } of [...catalog].sort((a, b) =>
    byVersion(a.manifest.version, b.manifest.version),
  ))
    byName.set(manifest.name, manifest);
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/**
 * Templates that suit a project, from the kinds `detectProjectTypes` found in it (PIPE-4): the newest
 * version of each template whose `detects` names one of them, the surest first and then by name.
 * A project that looks like nothing the catalog knows (Terraform today, or an empty repository) gets none.
 */
export function recommend(
  detected: readonly DetectedType[],
  catalog: readonly Template[],
): Recommendation[] {
  return newest(catalog)
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

/** Runner executors that start a container: GitLab's secret detection runs in an analyzer image. */
const CONTAINER_EXECUTORS = ["docker", "docker+machine", "docker-autoscaler", "kubernetes"];

/**
 * What to tell a project that switches secret detection on (SCAN-5). It is a warning, never a failure:
 * the platform cannot see the project's runners' executors (`executors` left out: GitLab's runner API does
 * not report one), and a runner it cannot see may well run containers.
 */
export function secretDetectionWarnings(o: {
  secretDetection?: boolean;
  /** The executors of the project's runners, when they are known. */
  executors?: readonly string[];
}): string[] {
  if (!o.secretDetection) return [];
  const needs = `GitLab's secret detection runs in a container, so it needs a runner with the ${CONTAINER_EXECUTORS.join(", ")} executor.`;
  if (o.executors === undefined)
    return [
      `The project's runners are not known, so it is not known whether one can run it. ${needs}`,
    ];
  if (o.executors.some((e) => CONTAINER_EXECUTORS.includes(e))) return [];
  const have = [...new Set(o.executors)].sort().join(", ");
  return [`None of the project's runners can run it (${have || "it has none"}). ${needs}`];
}
