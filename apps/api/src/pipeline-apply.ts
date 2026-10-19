import { createHash } from "node:crypto";
import { APP_NAME, DomainError } from "@orch/core";
import { type Db, getProject, type NewPipelineConfig } from "@orch/db";
import { type Gitlab, GitlabError } from "@orch/gitlab";
import {
  byVersion,
  componentPath,
  GENERATED,
  type IncludeTarget,
  includePath,
  type Layer,
  RenderError,
  render,
  renderComponent,
  renderInclude,
  type Template,
  type Validation,
} from "@orch/pipelines";
import type { GuardrailConfig } from "@orch/sync";
import { WHY } from "./connections";
import { WAY_OUT } from "./guardrails";
import { validatePipeline } from "./pipeline-validate";

export const PIPELINE_FILE = ".gitlab-ci.yml";
/** The branch the merge request comes from: one per project, so a re-run finds it again. */
export const PIPELINE_BRANCH = `${APP_NAME}/pipeline`;

/** How the pipeline reaches the repository: the whole file, an `include:` of the template, or a CI/CD component (PIPE-9, CMP-2). */
export type PipelineMode = "inline" | "include" | "component";

export interface PipelineRequest {
  template: string;
  /** The newest version of the template when left out. */
  version?: string;
  params?: Record<string, unknown>;
  overrides?: Layer["overrides"];
  /** Environment slugs the required variables are checked in; all of the project's when left out. */
  environments?: string[];
  /** `inline` (the default) commits the whole pipeline; `include` commits a thin file that includes the template from `include` (PIPE-9); `component` one that uses it as a component of `include.project` at the version `include.ref` (CMP-2). */
  mode?: PipelineMode;
  /** The templates project the template's file is published in; given with the `include` and `component` modes and only then. The ref is required for a component. */
  include?: IncludeTarget;
}

/** What is on the default branch now: nothing, a file of ours (unchanged or not), or one written by hand. */
export type Existing = "none" | "identical" | "generated" | "hand-written";

export interface Prepared {
  text: string;
  /** The file on the default branch now; null when there is none. */
  current: string | null;
  renderedHash: string;
  validation: Validation;
  existing: Existing;
  template: Template["manifest"];
  mode: PipelineMode;
}

export interface Applied extends Omit<Prepared, "text" | "current" | "template"> {
  /** `opened` a new merge request, `updated` one that was open, `unchanged` (nothing to do), `in_place` (the default branch already has this file). */
  outcome: "opened" | "updated" | "unchanged" | "in_place";
  /** A commit was made on the branch this time. */
  committed: boolean;
  mr: { iid: number; url: string } | null;
  /** What to store for the project once this is recorded. */
  config: NewPipelineConfig;
}

export interface PipelineDeps {
  db: Db;
  catalog: readonly Template[];
  /** Opens the connection that reaches the project; called once the project is known to be there. */
  gitlab: () => Promise<Gitlab>;
  /** The built-in guardrails (POL-4); the defaults when left out. */
  guardrails?: GuardrailConfig | undefined;
}

/** GitLab refusing or failing, as the API reports it: about this project (422) or about GitLab (502). */
export const gitlabProblem = (e: unknown) => {
  if (!(e instanceof GitlabError)) return e;
  const aboutProject = e.kind === "not_found" || e.kind === "forbidden";
  return new DomainError(
    aboutProject ? "gitlab_project_unreachable" : "gitlab_failed",
    aboutProject ? 422 : 502,
    aboutProject
      ? "GitLab has no such project, or the connection's token cannot use it."
      : WHY[e.kind],
  );
};

const notFound = <T>(read: Promise<T>) =>
  read.catch((e) => {
    if (e instanceof GitlabError && e.kind === "not_found") return null;
    throw e;
  });

export const pick = (catalog: readonly Template[], name: string, version?: string) => {
  const found = catalog
    .filter(
      (t) => t.manifest.name === name && (version === undefined || t.manifest.version === version),
    )
    .sort((a, b) => byVersion(a.manifest.version, b.manifest.version))
    .at(-1);
  if (!found) {
    throw new DomainError(
      "unknown_template",
      422,
      version === undefined ? `No template ${name}` : `No template ${name} at version ${version}`,
    );
  }
  return found;
};

const sentence = (lines: string[]) => lines.join("; ");

/**
 * Renders the pipeline, has GitLab lint it and checks the variables it needs (PIPE-3, PIPE-5), and
 * looks at what the default branch holds. Writes nothing anywhere.
 */
async function prepare(
  deps: PipelineDeps,
  orgId: string,
  projectId: string,
  request: PipelineRequest,
) {
  const project = await getProject(deps.db, orgId, projectId);
  if (!project) throw new DomainError("not_found", 404, "Project not found");
  if (!project.gitlabProjectId) {
    throw new DomainError("not_linked", 422, "This project was not imported from GitLab");
  }
  const template = pick(deps.catalog, request.template, request.version);
  const layer: Layer = { params: request.params, overrides: request.overrides };
  const mode = request.mode ?? "inline";
  const { include } = request;
  if ((mode !== "inline") !== (include !== undefined)) {
    throw new DomainError(
      "invalid_pipeline",
      422,
      mode === "inline"
        ? "A templates project goes with the include and component modes alone"
        : `The ${mode} mode needs the templates project`,
    );
  }
  let text: string;
  try {
    text = !include
      ? render(template, [layer])
      : mode === "component"
        ? renderComponent(template, [layer], {
            project: include.project,
            version: include.ref ?? "",
          })
        : renderInclude(template, [layer], include);
  } catch (e) {
    if (e instanceof RenderError) {
      throw new DomainError("invalid_pipeline", 422, sentence(e.problems.slice(0, 10)));
    }
    throw e;
  }
  const ref = project.gitlabProjectId;
  const api = await deps.gitlab();
  try {
    const base = (await api.projects.get(ref)).defaultBranch;
    if (!base)
      throw new DomainError("no_default_branch", 422, "The repository has no default branch yet");
    const validation = await validatePipeline(deps.db, {
      organizationId: orgId,
      projectId,
      template,
      text,
      lint: (content) => api.ci.lint(ref, content),
      environments: request.environments,
      guardrails: deps.guardrails,
    });
    const onDefault =
      (await notFound(api.repository.getFile(ref, PIPELINE_FILE, base)))?.content ?? null;
    const existing: Existing =
      onDefault === null
        ? "none"
        : onDefault === text
          ? "identical"
          : onDefault.startsWith(GENERATED)
            ? "generated"
            : "hand-written";
    const prepared: Prepared = {
      text,
      current: onDefault,
      renderedHash: createHash("sha256").update(text).digest("hex"),
      validation,
      existing,
      template: template.manifest,
      mode,
    };
    return { api, ref, base, onDefault, prepared, template };
  } catch (e) {
    throw gitlabProblem(e);
  }
}

/** What applying this would put in the repository, without touching it. */
export async function previewPipeline(
  deps: PipelineDeps,
  orgId: string,
  projectId: string,
  request: PipelineRequest,
): Promise<Prepared> {
  return (await prepare(deps, orgId, projectId, request)).prepared;
}

/** GitLab's lint says the pipeline is wrong: nothing is committed. */
export const lintRefusal = (validation: Validation) =>
  new DomainError(
    "pipeline_invalid",
    422,
    `GitLab's lint refuses this pipeline: ${sentence(validation.lint.errors.slice(0, 3).map(clip))}`,
  );

/** The pipeline would run in a production environment whose variables are open to every branch: nothing is committed. */
export const violationRefusal = (validation: Validation) =>
  new DomainError(
    "guardrail_violation",
    422,
    `The pipeline breaks ${validation.violations.length === 1 ? "a guardrail" : "guardrails"}: ${sentence(validation.violations.slice(0, 3).map((v) => `${v.rule}: ${v.message}`))}. ${WAY_OUT}`,
  );

const SHOWN = 10;
const clip = (s: string) => s.replaceAll("`", "'").slice(0, 300);

/** The merge request's text. The same inputs give the same text, so a re-run changes nothing. */
function describeMr(p: Prepared, request: PipelineRequest, version: string) {
  const given = Object.entries(request.params ?? {});
  const overrides = Object.keys(request.overrides ?? {}).length;
  const lines = [
    `Generated by ${APP_NAME} from the template **${p.template.name}** ${version}. Change the pipeline there, not in this file: it is rewritten on the next run.`,
    "",
    p.existing === "hand-written"
      ? `**This replaces the \`${PIPELINE_FILE}\` that is on the default branch, which was written by hand. Read the diff before merging.**`
      : `This ${p.existing === "none" ? "adds" : "updates"} \`${PIPELINE_FILE}\`.`,
    "",
    `Parameters: ${given.length === 0 ? "the template's defaults" : given.map(([k, v]) => `\`${k}\` = \`${clip(JSON.stringify(v))}\``).join(", ")}.`,
  ];
  if (request.include && p.mode === "component") {
    const { project, ref = "" } = request.include;
    // a partial release follows the newest matching one: it moves without a merge request here
    const moves = !/^(\d+\.\d+\.\d+|[0-9a-f]{40})$/.test(ref);
    lines.push(
      "",
      `The pipeline itself is not in this file: it uses the component \`${p.template.name}\` of \`${project}\` at \`${clip(ref)}\`, and passes it these parameters. \`${componentPath(p.template)}\` must be published in that version before this is merged. Whoever can release \`${project}\` changes this project's pipeline${moves ? `, and \`${clip(ref)}\` follows the newest matching release, so it can change without a merge request here` : ""}.`,
    );
  } else if (request.include) {
    const { project, ref } = request.include;
    lines.push(
      "",
      `The pipeline itself is not in this file: it includes \`${includePath(p.template)}\` of \`${project}\`${ref === undefined ? "" : ` at \`${clip(ref)}\``}, and passes it these parameters. That file must be published there before this is merged. Whoever can change \`${project}\` changes this project's pipeline.`,
    );
  }
  if (overrides > 0)
    lines.push(
      `Overrides: ${overrides} entr${overrides === 1 ? "y" : "ies"} merged over the template.`,
    );
  const missing = p.validation.missingVariables;
  if (missing.length > 0) {
    lines.push("", "**Variables the pipeline needs that are not set yet**");
    for (const m of missing) {
      lines.push(
        `- ${m.environment === null ? "project" : `\`${m.environment}\``}: ${m.keys.map((k) => `\`${k}\``).join(", ")}`,
      );
    }
  }
  const warnings = p.validation.lint.warnings;
  if (warnings.length > 0) {
    lines.push("", "**GitLab's lint warns**");
    for (const w of warnings.slice(0, SHOWN)) lines.push(`- ${clip(w)}`);
    if (warnings.length > SHOWN) lines.push(`- and ${warnings.length - SHOWN} more`);
  }
  return lines.join("\n");
}

/**
 * Lands the pipeline as a merge request (PIPE-6): the file is committed to the branch
 * `orch/pipeline` (made from the default branch if it is not there), and one merge request from it
 * is opened or, if it is already open, updated. Nothing is ever committed to the default branch, and
 * a pipeline GitLab's lint refuses, or one that breaks a guardrail, is not committed at all (a file
 * already in place on the default branch commits nothing, so it is not refused for a guardrail). Running it again with the same inputs
 * makes no commit and changes nothing; with other inputs it commits on the same branch and edits the
 * same merge request. A hand-written file on the default branch is replaced only by the merge request,
 * which says so. Missing variables do not stop it: they are listed in the merge request.
 */
export async function applyPipeline(
  deps: PipelineDeps,
  orgId: string,
  projectId: string,
  connectionId: string,
  request: PipelineRequest,
): Promise<Applied> {
  const { api, ref, base, onDefault, prepared, template } = await prepare(
    deps,
    orgId,
    projectId,
    request,
  );
  const { text, validation, existing, renderedHash } = prepared;
  const { version } = template.manifest;
  if (!validation.lint.valid) throw lintRefusal(validation);
  const config = (mr: Applied["mr"]): NewPipelineConfig => ({
    organizationId: orgId,
    projectId,
    connectionId,
    template: template.manifest.name,
    version,
    params: request.params ?? {},
    overrides: request.overrides ?? {},
    renderedHash,
    mode: prepared.mode,
    includeProject: request.include?.project ?? null,
    includeRef: request.include?.ref ?? null,
    mrIid: mr?.iid ?? null,
    mrUrl: mr?.url ?? null,
  });
  const done = (outcome: Applied["outcome"], committed: boolean, mr: Applied["mr"]): Applied => ({
    outcome,
    committed,
    mr,
    renderedHash,
    validation,
    existing,
    mode: prepared.mode,
    config: config(mr),
  });
  if (onDefault === text) return done("in_place", false, null);
  // a file already in place commits nothing, so a guardrail has nothing to refuse
  if (validation.violations.length > 0) throw violationRefusal(validation);

  try {
    const onBranch = await notFound(api.repository.getBranch(ref, PIPELINE_BRANCH));
    const there = onBranch
      ? ((await notFound(api.repository.getFile(ref, PIPELINE_FILE, PIPELINE_BRANCH)))?.content ??
        null)
      : null;
    let committed = false;
    if (there !== text) {
      const action = (onBranch ? there : onDefault) === null ? "create" : "update";
      await api.repository.commitFiles(
        ref,
        {
          branch: PIPELINE_BRANCH,
          message: `Set up CI from the ${template.manifest.name} template ${version}`,
          ...(onBranch ? {} : { startBranch: base }),
        },
        [{ action, path: PIPELINE_FILE, content: text }],
      );
      committed = true;
    }

    const title = `Set up CI from the ${template.manifest.name} template`;
    const description = describeMr(prepared, request, version);
    let open: Awaited<ReturnType<Gitlab["mergeRequests"]["get"]>> | undefined;
    for await (const mr of api.mergeRequests.list(ref, {
      sourceBranch: PIPELINE_BRANCH,
      targetBranch: base,
      state: "opened",
    })) {
      open = mr;
      break;
    }
    if (!open) {
      const mr = await api.mergeRequests.create(ref, {
        sourceBranch: PIPELINE_BRANCH,
        targetBranch: base,
        title,
        description,
        removeSourceBranch: true,
      });
      return done("opened", committed, { iid: mr.iid, url: mr.webUrl });
    }
    // GitLab may store the text with other line endings or trimmed: only a real difference is an edit
    const same = (a: string, b: string) => a.replaceAll("\r\n", "\n").trim() === b.trim();
    const edited = open.title !== title || !same(open.description, description);
    const mr = edited
      ? await api.mergeRequests.update(ref, open.iid, { title, description })
      : open;
    return done(committed || edited ? "updated" : "unchanged", committed, {
      iid: mr.iid,
      url: mr.webUrl,
    });
  } catch (e) {
    throw gitlabProblem(e);
  }
}
