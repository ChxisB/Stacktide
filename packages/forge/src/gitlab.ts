import type { Gitlab } from "@orch/gitlab";
import { capabilitiesOf } from "./capabilities";
import type { Forge } from "./index";

/** The GitLab adapter: the gateway as it is, without the operations outside the table, and every capability. */
export function gitlabForge(api: Gitlab): Forge {
  const { groups: _notInTheTable, ...operations } = api;
  return {
    ...operations,
    kind: "gitlab",
    capabilities: capabilitiesOf("gitlab"),
  };
}
