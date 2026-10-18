import { DomainError } from "@orch/core";
import { type Executor, protectedEnvironments, type SyncTarget } from "@orch/db";

/**
 * The protected environments (GOV-3) whose variables the target gets: any one of them makes every
 * apply of the target wait for an approval, as the target gets the project's variables as a whole.
 */
export const protectedMappings = (
  db: Executor,
  target: Pick<SyncTarget, "organizationId" | "projectId" | "environmentMapping">,
) =>
  protectedEnvironments(
    db,
    target.organizationId,
    target.projectId,
    Object.keys(target.environmentMapping),
  );

/** The apply cannot start: it is in the reach of a protected environment and no one else has approved it. */
export const approvalRequired = (what: string, slugs: readonly string[]) =>
  new DomainError(
    "approval_required",
    409,
    `${what} is guarded by the protected environment ${slugs.slice(0, 5).join(", ")}: ask for approval in its change requests, and have someone other than you approve it`,
  );
