import { DomainError } from "@orch/core";
import type { Executor } from "@orch/db";
import {
  currentDeployments,
  getPipelineConfig,
  hasSucceeded,
  listEnvironments,
  previousSuccess,
} from "@orch/db";
import type { PipelineVariable } from "@orch/gitlab";

/**
 * What a promotion would do: the environment, the build there now (if any), the one going there, and the
 * pipeline's variable names. A protected environment is entered with an approval, which the start takes.
 */
export interface PromotionPlan {
  environment: string;
  environmentId: string;
  protected: boolean;
  from: { sha: string; finishedAt: Date | null } | null;
  to: string;
  previous: string | null;
  defaultBranch: string;
  variables: string[];
}

/** The templates that deploy a build named by `ORCH_DEPLOY_ENV` and `ORCH_DEPLOY_SHA`: the cloud ones are CLD-7 and CLD-8. */
const DEPLOY_TEMPLATES = ["docker-deploy", "cloud-run", "ecs"];

// The patterns the `docker-deploy` template's script checks (`is_slug`, `is_sha`), and the platform's
// environment slugs: a value that passes here passes there.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{40}$/;

/**
 * What the pipeline is started with: exactly these, in this order, and nothing free-text (the template's
 * script checks each). `ORCH_PREVIOUS_SHA` is left out when nothing was deployed there.
 */
export const promotionVariables = (p: {
  environment: string;
  to: string;
  previous: string | null;
}): PipelineVariable[] => [
  { key: "ORCH_DEPLOY_ENV", value: p.environment },
  { key: "ORCH_DEPLOY_SHA", value: p.to },
  ...(p.previous ? [{ key: "ORCH_PREVIOUS_SHA", value: p.previous }] : []),
];

const refused = (code: string, status: number, message: string) =>
  new DomainError(code, status, message);

/** A build is named by its full commit sha. */
export function assertSha(sha: string): void {
  if (!SHA.test(sha))
    throw refused("invalid_sha", 400, "The build must be a full 40-character commit sha");
}

/** Only a build that has been deployed successfully, somewhere in the project, may be promoted. */
export async function assertKnownBuild(
  db: Executor,
  project: { id: string; organizationId: string },
  sha: string,
): Promise<void> {
  if (!(await hasSucceeded(db, project.organizationId, project.id, sha)))
    throw refused(
      "unknown_build",
      422,
      "Only a build that has been deployed successfully somewhere in this project can be promoted",
    );
}

type Project = { id: string; organizationId: string; defaultBranch: string };

/**
 * Decides, from the database alone, whether `sha` may be deployed to the project's environment `environment`
 * (its slug), and what that would do. Throws the refusal otherwise. Nothing is asked of GitLab, and nothing
 * is written: the dry run answers this, and applying starts from it.
 *
 * shortcut: the table only knows what GitLab has reported, so two requests within seconds of each other both
 * pass the "in progress" check; GitLab's resource group makes the second deploy wait, then run the same build
 * again (docs/deployments.md: the script must be safe to run twice). Upgrade when a lock per environment is wanted.
 */
export const planPromotion = (
  db: Executor,
  input: { project: Project; environment: string; sha: string },
) => plan(db, input.project, input.environment, input.sha);

/**
 * The plan of rolling `environment` back: a promotion, to the same environment, of the newest build that
 * succeeded there before its current one. It has every refusal a promotion has, and `nothing_to_roll_back`.
 */
export const planRollback = (db: Executor, input: { project: Project; environment: string }) =>
  plan(db, input.project, input.environment, null);

/** One path for both: a `sha` of null means "the build before the current one" (a rollback). */
async function plan(
  db: Executor,
  project: Project,
  environment: string,
  sha: string | null,
): Promise<PromotionPlan> {
  // the same patterns the template's script checks; the check is the plan's, never left to the pipeline
  if (sha !== null) assertSha(sha);
  if (!SLUG.test(environment) || environment.length > 63)
    throw refused("invalid_environment", 400, "The environment must be an environment's slug");

  const target = (await listEnvironments(db, project.organizationId, project.id)).find(
    (e) => e.slug === environment,
  );
  if (!target) throw new DomainError("not_found", 404, "Environment not found");
  const here = (await currentDeployments(db, project.organizationId, project.id)).find(
    (d) => d.environment === environment,
  );
  let to = sha;
  if (to === null) {
    // a build that succeeded in this very environment worked somewhere, so `unknown_build` cannot apply
    const before =
      here?.current &&
      (await previousSuccess(
        db,
        project.organizationId,
        project.id,
        environment,
        here.current.sha,
      ));
    if (!before)
      throw refused(
        "nothing_to_roll_back",
        409,
        "No earlier build has been deployed successfully to this environment",
      );
    to = before.sha;
  } else await assertKnownBuild(db, project, to);
  if (here?.current?.sha === to)
    throw refused("already_deployed", 409, "This build is already what is deployed there");
  if (here && ["running", "created"].includes(here.lastAttempt.status))
    throw refused(
      "deployment_in_progress",
      409,
      "A deployment to this environment is still running",
    );

  const config = await getPipelineConfig(db, project.organizationId, project.id);
  if (!config || !DEPLOY_TEMPLATES.includes(config.template))
    throw refused(
      "no_deploy_pipeline",
      422,
      `This project's pipeline was not set up with a deploy template (${DEPLOY_TEMPLATES.join(", ")})`,
    );

  const previous = here?.current?.sha ?? null;
  return {
    environment,
    environmentId: target.id,
    protected: target.protected,
    from: here?.current ? { sha: here.current.sha, finishedAt: here.current.finishedAt } : null,
    to,
    previous,
    defaultBranch: project.defaultBranch,
    variables: promotionVariables({ environment, to, previous }).map((v) => v.key),
  };
}
