import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";

// `enterprise` is missing from older releases; the version string then carries `-ee`.
const versionBody = z.object({ version: z.string(), enterprise: z.boolean().optional() });

/** Which GitLab this is. `major` and `minor` are null for a string that does not start with a version. */
export interface InstanceInfo {
  version: string;
  major: number | null;
  minor: number | null;
  /** Enterprise Edition. Not the same as Premium or Ultimate: the licence is not in the API. */
  enterprise: boolean;
}

export function parseInstance(version: string, enterprise?: boolean): InstanceInfo {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  return {
    version,
    major: m ? Number(m[1]) : null,
    minor: m ? Number(m[2]) : null,
    enterprise: enterprise ?? /-ee\b/.test(version),
  };
}

export type CapabilityId = "hiddenVariables" | "groupVariableScopes";

/** `unknown` is for what the API cannot tell: neither a yes nor a refusal. */
export interface Capability {
  id: CapabilityId;
  label: string;
  state: "yes" | "no" | "unknown";
  needs: string;
}

const atLeast = (i: InstanceInfo, major: number, minor: number) =>
  i.major === null || i.minor === null
    ? "unknown"
    : i.major > major || (i.major === major && i.minor >= minor)
      ? "yes"
      : "no";

/**
 * What this instance can do that the platform uses and that not every GitLab can. Only what GitLab's
 * documentation states today (FRG-3 LOG): `id_tokens` and `artifacts:access` were introduced long
 * enough ago that the notes are gone from the docs, and are not checked here.
 */
export const capabilitiesOf = (info: InstanceInfo): Capability[] => [
  {
    id: "hiddenVariables",
    label: "Hidden variables",
    state: atLeast(info, 17, 4),
    needs: "GitLab 17.4 or later",
  },
  {
    id: "groupVariableScopes",
    label: "Environment scopes on group variables",
    state: info.enterprise ? "unknown" : "no",
    needs: "GitLab Premium or Ultimate",
  },
];

export function instanceApi(client: GitlabClient) {
  return {
    instance: {
      /** `GET /version`: the release and the edition. */
      async info() {
        const b = decode(versionBody, await client.request("GET", "/version"), "version");
        return parseInstance(b.version, b.enterprise);
      },
    },
  };
}
