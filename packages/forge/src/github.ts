import {
  environmentsApi,
  type FindTuning,
  type GithubClient,
  membersApi,
  pipelinesApi,
  projectsApi,
  pullRequestsApi,
  repoBase,
  repositoryApi,
} from "@orch/github";
import type { Gitlab } from "@orch/gitlab";
import { capabilitiesOf } from "./capabilities";
import type { Forge } from "./index";
import { unbuilt } from "./unbuilt";

/**
 * The GitHub adapter. Built so far: projects, repository (files, trees, branches, commits, compare, tags), pull
 * requests with their comments and their approval state, workflow runs read, started (`startRun`, FRG-30), retried
 * and cancelled, members (a collaborator's or an organization member's access level), and `applyGate` (FRG-29:
 * whether an environment holds a job for required reviewers). Every other group refuses by name until the task that builds it (FRG-20 secrets, ...), and every
 * capability says no until then: a flag turns on with the task that makes it true.
 */
export function githubForge(client: GithubClient, find?: FindTuning): Forge {
  const projects = projectsApi(client);
  const base = repoBase(client);
  const { applyGate } = environmentsApi(client, base);
  const { pipelines, startRun } = pipelinesApi(client, base, find);
  const refused = unbuilt<Pick<Gitlab["pipelines"], "trigger" | "artifact">>("pipelines");
  return {
    ...projects,
    ...repositoryApi(client, base, projects.projects.get),
    ...pullRequestsApi(client, base, projects.projects.get),
    users: unbuilt<Gitlab["users"]>("users"),
    ...membersApi(client, base),
    // a run is started by `startRun`, not by a child pipeline, and its artifacts are not read yet: these two refuse by name
    pipelines: {
      ...pipelines,
      trigger: refused.trigger,
      artifact: refused.artifact,
    },
    ci: unbuilt<Gitlab["ci"]>("ci"),
    deployments: unbuilt<Gitlab["deployments"]>("deployments"),
    environments: unbuilt<Gitlab["environments"]>("environments"),
    instance: unbuilt<Gitlab["instance"]>("instance"),
    variables: unbuilt<Gitlab["variables"]>("variables"),
    accessTokens: unbuilt<Gitlab["accessTokens"]>("accessTokens"),
    runners: unbuilt<Gitlab["runners"]>("runners"),
    terraformState: unbuilt<Gitlab["terraformState"]>("terraformState"),
    applyGate,
    startRun,
    kind: "github",
    capabilities: capabilitiesOf("github"),
  };
}
