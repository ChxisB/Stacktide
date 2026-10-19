import { accessTokensApi } from "./access-tokens";
import { type ClientOptions, createGitlabClient, type GitlabClient } from "./client";
import { membersApi } from "./members";
import { mergeRequestsApi } from "./merge-requests";
import { pipelinesApi } from "./pipelines";
import { projectsApi } from "./projects";
import { repositoryApi } from "./repository";
import { runnersApi } from "./runners";
import { terraformStateApi } from "./terraform-state";
import { variablesApi } from "./variables";

/** The typed gateway to GitLab: every method returns a domain type, never raw API JSON. */
export function gitlabApi(client: GitlabClient) {
  const projects = projectsApi(client);
  return {
    ...projects,
    ...repositoryApi(client, projects.projects.get),
    ...membersApi(client),
    ...mergeRequestsApi(client),
    ...pipelinesApi(client),
    ...variablesApi(client),
    ...accessTokensApi(client),
    ...runnersApi(client),
    ...terraformStateApi(client),
  };
}

export type Gitlab = ReturnType<typeof gitlabApi>;

export const createGitlab = (opts: ClientOptions): Gitlab => gitlabApi(createGitlabClient(opts));
