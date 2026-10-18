import type { Tool } from "@orch/iac";
import { z } from "zod";

/**
 * An image repository (no tag; the stack's version is the tag) per tool, for the generated pipelines.
 * Terraform and OpenTofu have defaults; Terragrunt has none. A stack with an `environment` needs its
 * tool's here too: its plan job runs `orch`, which the stock images do not hold.
 */
export const toolImageEnv = {
  ORCH_TERRAFORM_IMAGE: z.string().min(1).optional(),
  ORCH_TOFU_IMAGE: z.string().min(1).optional(),
  ORCH_TERRAGRUNT_IMAGE: z.string().min(1).optional(),
};

export const toolImages = (
  config: Partial<Record<keyof typeof toolImageEnv, string | undefined>>,
): Partial<Record<Tool, string>> =>
  Object.fromEntries(
    (
      [
        ["terraform", config.ORCH_TERRAFORM_IMAGE],
        ["tofu", config.ORCH_TOFU_IMAGE],
        ["terragrunt", config.ORCH_TERRAGRUNT_IMAGE],
      ] as const
    ).filter(([, repository]) => repository !== undefined),
  );
