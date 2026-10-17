import { DomainError } from "@orch/core";
import { chainKeys, type Db, getProject, listEnvironments } from "@orch/db";
import { type Lint, type Template, type Validation, validate } from "@orch/pipelines";

/**
 * Checks a rendered pipeline for a project (PIPE-5): GitLab's lint (`lint`, built from the
 * connection that reaches the project) and that the variables the template requires are set in
 * every environment, or in the ones named. Reads variable names only, so it opens no secret and
 * needs no master key. Writes nothing.
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
  });
}
