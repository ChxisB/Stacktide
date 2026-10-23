import type { Platform, Tool } from "@orch/iac";
import { z } from "zod";

/**
 * An image repository (no tag; the stack's version is the tag) per tool, for the generated pipelines.
 * Terraform, OpenTofu and DNSControl have defaults; Terragrunt has none. A stack with an `environment` needs its
 * tool's here too: its plan job runs `orch`, which the stock images do not hold. A DNS zone's apply job also reads
 * the plan with `jq` and `wget`, so applying a zone needs the DNSControl image set, whatever its environment.
 */
export const toolImageEnv = {
  ORCH_TERRAFORM_IMAGE: z.string().min(1).optional(),
  ORCH_TOFU_IMAGE: z.string().min(1).optional(),
  ORCH_TERRAGRUNT_IMAGE: z.string().min(1).optional(),
  ORCH_DNSCONTROL_IMAGE: z.string().min(1).optional(),
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
        ["dnscontrol", config.ORCH_DNSCONTROL_IMAGE],
      ] as const
    ).filter(([, repository]) => repository !== undefined),
  );

/**
 * Where the platform is, for the jobs an apply starts (a stack whose state is on the platform signs in to it, STATE-5):
 * both the address CI jobs reach the API at and the audience of their token, or nothing. A trailing slash is the
 * usual way to write an address; the generator wants none.
 */
export const platformOf = (
  apiUrl: string | undefined,
  audience: string | undefined,
): Platform | undefined =>
  apiUrl !== undefined && audience !== undefined
    ? { apiUrl: apiUrl.replace(/\/+$/, ""), audience }
    : undefined;
