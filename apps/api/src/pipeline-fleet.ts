import { DomainError, type Logger } from "@orch/core";
import { type Db, listPinnedPipelines } from "@orch/db";
import type { Gitlab } from "@orch/gitlab";
import { byVersion, type Template } from "@orch/pipelines";
import {
  type Applied,
  applyPipeline,
  lintRefusal,
  type PipelineDeps,
  type PipelineRequest,
  pick,
  previewPipeline,
} from "./pipeline-apply";

/** Projects handled by one call, at most; the caller continues from `next`. */
export const FLEET_MAX_BATCH = 50;
export const FLEET_DEFAULT_BATCH = 10;
/** Between two projects of a batch: GitLab limits requests per token, and each project takes several. */
export const FLEET_PAUSE_MS = 500;

export interface FleetDeps {
  db: Db;
  catalog: readonly Template[];
  /** The GitLab client of one of the organization's connections. */
  gitlab: (connectionId: string) => Promise<Gitlab>;
  /** Stores what an apply did to one project: its configuration and the audit row, in one transaction. */
  record: (projectId: string, applied: Applied) => Promise<void>;
  /** Waits between two projects (the rate limit); a test passes one that does not wait. */
  pause: (ms: number) => Promise<void>;
  pauseMs?: number;
  logger: Logger;
}

export interface FleetRequest {
  template: string;
  /** The newest version of the template when left out. */
  version?: string;
  /** Projects handled by this call. */
  limit: number;
  /** Continue after this project (the `next` of the call before). */
  after?: string;
}

/** `would_upgrade` and `no_change` are what a dry run says; `upgraded` is an apply that went through. */
export type FleetStatus =
  | "would_upgrade"
  | "no_change"
  | "upgraded"
  | "skipped"
  | "blocked"
  | "failed";

export interface FleetItem {
  projectId: string;
  projectName: string;
  from: string;
  to: string;
  status: FleetStatus;
  /** What the file on the default branch would gain and lose (a dry run only; see `lineChanges`). */
  changes: { added: number; removed: number } | null;
  /** What the default branch holds now: a `hand-written` file is replaced by the merge request. */
  existing: Applied["existing"] | null;
  /** What an apply did: a merge request `opened` or `updated`, nothing to do (`unchanged`), or the file was already there (`in_place`). */
  outcome: Applied["outcome"] | null;
  mr: { iid: number; url: string } | null;
  /** Why it was `skipped`, `blocked` or `failed`; no value of the project is in it. */
  code: string | null;
  message: string | null;
}

export interface FleetResult {
  template: string;
  /** The version the projects are moved to. */
  target: string;
  items: FleetItem[];
  /** Where to continue; null when this was the last batch. */
  next: string | null;
}

/** The project's template cannot be rendered or linted at the new version: the owner has to change it. */
const BLOCKED = new Set(["invalid_pipeline", "pipeline_invalid", "unknown_template"]);

/**
 * Lines gained and lost between two texts, as multisets: a line that only moved counts as no change.
 * A summary for the dry run, not a diff (the merge request has the real one).
 */
export function lineChanges(from: string | null, to: string) {
  const count = (text: string | null) => {
    const lines = new Map<string, number>();
    // the newline that ends a file does not start a line, and CRLF is a line end like LF
    for (const line of text ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [])
      lines.set(line, (lines.get(line) ?? 0) + 1);
    return lines;
  };
  const [a, b] = [count(from), count(to)];
  let added = 0;
  let removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { added, removed };
}

/** One batch of the projects set up from a template at another version than the target. */
async function page(db: Db, catalog: readonly Template[], orgId: string, req: FleetRequest) {
  const { manifest } = pick(catalog, req.template, req.version);
  const found = await listPinnedPipelines(db, orgId, {
    template: manifest.name,
    notVersion: manifest.version,
    after: req.after,
    limit: req.limit + 1,
  });
  const rows = found.slice(0, req.limit);
  return {
    template: manifest.name,
    target: manifest.version,
    rows,
    next: found.length > req.limit ? (rows.at(-1)?.config.projectId ?? null) : null,
  };
}

/** The projects that would be moved, from the database alone (GitLab is not asked). */
export async function listFleet(
  deps: Pick<FleetDeps, "db" | "catalog">,
  orgId: string,
  req: FleetRequest,
) {
  const { template, target, rows, next } = await page(deps.db, deps.catalog, orgId, req);
  return {
    template,
    target,
    projects: rows.map(({ config, projectName }) => ({
      projectId: config.projectId,
      projectName,
      version: config.version,
      mrIid: config.mrIid,
      mrUrl: config.mrUrl,
    })),
    next,
  };
}

/**
 * Moves the projects set up from a template to another version of it (PIPE-7), `limit` at a time.
 * A `plan` is the dry run: each project's pipeline is rendered from its stored parameters at the
 * target version and linted, and the lines it would change are counted; nothing is written. An
 * `apply` does what PIPE-6 does for each project (one merge request on the branch `orch/pipeline`),
 * pausing between projects, and records the new version only for a project that went through. One
 * project failing or being refused stops no other. Progress is the stored version: a project that was
 * upgraded is no longer listed, so running it again, or continuing from `next`, only meets what is left.
 */
export async function upgradeFleet(
  deps: FleetDeps,
  orgId: string,
  req: FleetRequest,
  mode: "plan" | "apply",
): Promise<FleetResult> {
  const { template, target, rows, next } = await page(deps.db, deps.catalog, orgId, req);
  const items: FleetItem[] = [];
  let touched = false;
  for (const { config, projectName } of rows) {
    const item: FleetItem = {
      projectId: config.projectId,
      projectName,
      from: config.version,
      to: target,
      status: "skipped",
      changes: null,
      existing: null,
      outcome: null,
      mr: null,
      code: null,
      message: null,
    };
    if (byVersion(config.version, target) > 0) {
      items.push({
        ...item,
        code: "newer",
        message: `Already on ${config.version}, which is newer than ${target}`,
      });
      continue;
    }
    if (touched) await deps.pause(deps.pauseMs ?? FLEET_PAUSE_MS);
    touched = true;
    try {
      const request: PipelineRequest = {
        template,
        version: target,
        params: config.params,
        // `render` checks both: a stored blob it refuses is `invalid_pipeline`, which blocks the project
        overrides: config.overrides as PipelineRequest["overrides"],
        // a project keeps the way it is delivered: an upgrade never turns an include into an inline file
        mode: config.mode,
        ...(config.includeProject === null
          ? {}
          : {
              include: {
                project: config.includeProject,
                ...(config.includeRef === null ? {} : { ref: config.includeRef }),
              },
            }),
      };
      const pipelineDeps: PipelineDeps = {
        db: deps.db,
        catalog: deps.catalog,
        gitlab: () => deps.gitlab(config.connectionId),
      };
      if (mode === "plan") {
        const p = await previewPipeline(pipelineDeps, orgId, config.projectId, request);
        if (!p.validation.lint.valid) throw lintRefusal(p.validation);
        items.push({
          ...item,
          status: p.current === p.text ? "no_change" : "would_upgrade",
          changes: lineChanges(p.current, p.text),
          existing: p.existing,
        });
      } else {
        const applied = await applyPipeline(
          pipelineDeps,
          orgId,
          config.projectId,
          config.connectionId,
          request,
        );
        // set before recording: if that fails, the failed item still shows the merge request GitLab now has
        item.existing = applied.existing;
        item.outcome = applied.outcome;
        item.mr = applied.mr;
        await deps.record(config.projectId, applied);
        items.push({ ...item, status: "upgraded" });
      }
    } catch (e) {
      if (e instanceof DomainError) {
        items.push({
          ...item,
          status: BLOCKED.has(e.code) ? "blocked" : "failed",
          code: e.code,
          message: e.message,
        });
      } else {
        deps.logger.error("a pipeline upgrade failed unexpectedly", {
          project: config.projectId,
          error: e instanceof Error ? e.name : typeof e,
        });
        items.push({
          ...item,
          status: "failed",
          code: "internal",
          message: "Unexpected error: see the logs",
        });
      }
    }
  }
  return { template, target, items, next };
}
