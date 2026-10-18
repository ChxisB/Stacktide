import { DomainError } from "@orch/core";
import { chainKeys, type Db, getProject, listEnvironments, listSyncTargets } from "@orch/db";
import {
  type Lint,
  type PipelineViolation,
  type Template,
  type Validation,
  validate,
} from "@orch/pipelines";
import {
  checkScope,
  GITLAB_VARIABLES,
  type GuardrailConfig,
  parseGitlabVariablesConfig,
  SyncError,
} from "@orch/sync";

const TARGETS_PAGE = 100;

/**
 * The guardrails the environments break (POL-4): an environment the project's targets sync to a
 * production scope, on a target that does not protect its variables. A pipeline runs on any branch
 * and reads what is not protected, so its production variables would be open to every one of them.
 * The pipeline does not say which variables are secrets, so only the rule that holds for all of them applies.
 * shortcut: one target type; a second type needs the adapter to say whether it protects.
 */
async function guardrailViolations(
  db: Db,
  organizationId: string,
  projectId: string,
  environments: string[],
  guardrails: GuardrailConfig | undefined,
): Promise<PipelineViolation[]> {
  const found: PipelineViolation[] = [];
  if (environments.length === 0) return found;
  let after: string | undefined;
  for (;;) {
    const page = await listSyncTargets(db, organizationId, projectId, {
      after,
      limit: TARGETS_PAGE,
    });
    for (const target of page) {
      if (target.type !== GITLAB_VARIABLES) continue;
      let protectedTarget: boolean;
      try {
        protectedTarget = parseGitlabVariablesConfig(target.config).protected === true;
      } catch (e) {
        // a target whose config is refused cannot sync anything, so it breaks nothing
        if (e instanceof SyncError) continue;
        throw e;
      }
      for (const environment of environments) {
        const scope = target.environmentMapping[environment];
        const violation =
          scope === undefined
            ? undefined
            : checkScope(scope, { protected: protectedTarget }, guardrails);
        if (violation) {
          found.push({
            rule: violation.rule,
            message: `environment "${environment}" is synced to the production scope "${scope}" by the target "${target.name}", which does not protect its variables`,
          });
        }
      }
    }
    if (page.length < TARGETS_PAGE) return found;
    after = page[page.length - 1]?.id;
  }
}

/**
 * Checks a rendered pipeline for a project (PIPE-5): GitLab's lint (`lint`, built from the
 * connection that reaches the project) and that the variables the template requires are set in
 * every environment, or in the ones named. Reads variable names only, so it opens no secret and
 * needs no master key. Writes nothing. Also names the guardrails the environments break (POL-4).
 */
export async function validatePipeline(
  db: Db,
  input: {
    organizationId: string;
    projectId: string;
    template: Pick<Template, "manifest">;
    /** The rendered `.gitlab-ci.yml`. */
    text: string;
    lint: Lint;
    /** Environment slugs; all of the project's when left out or empty. */
    environments?: string[];
    /** The built-in guardrails; the defaults when left out. */
    guardrails?: GuardrailConfig | undefined;
  },
): Promise<Validation> {
  const { organizationId, projectId } = input;
  // an id pair that names nothing would otherwise pass as a project with no variables to check
  if (!(await getProject(db, organizationId, projectId))) {
    throw new DomainError("not_found", 404, "Project not found");
  }
  const all = await listEnvironments(db, organizationId, projectId);
  const wanted = input.environments?.length ? input.environments : undefined;
  const unknown = wanted?.filter((slug) => !all.some((e) => e.slug === slug)) ?? [];
  if (unknown.length > 0) {
    throw new DomainError("unknown_environment", 422, `No such environment: ${unknown.join(", ")}`);
  }
  const chosen = wanted ? all.filter((e) => wanted.includes(e.slug)) : all;
  // a project that has no environments still has variables of its own and its organization's
  const levels =
    chosen.length > 0
      ? chosen.map((e) => ({ environment: e.slug as string | null, environmentId: e.id }))
      : [{ environment: null, environmentId: undefined }];
  const variables = await Promise.all(
    levels.map(async ({ environment, environmentId }) => ({
      environment,
      keys: await chainKeys(db, { organizationId, projectId, environmentId }),
    })),
  );
  return validate({
    manifest: input.template.manifest,
    text: input.text,
    lint: input.lint,
    variables,
    violations: await guardrailViolations(
      db,
      organizationId,
      projectId,
      chosen.map((e) => e.slug),
      input.guardrails,
    ),
  });
}
