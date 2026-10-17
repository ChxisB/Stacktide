import { type ClientOptions, createGitlabClient, type GitlabClient } from "./client";
import { mergeRequestsApi } from "./merge-requests";
import { projectsApi } from "./projects";
import { repositoryApi } from "./repository";

/** The typed gateway to GitLab: every method returns a domain type, never raw API JSON. */
export function gitlabApi(client: GitlabClient) {
  const projects = projectsApi(client);
  return {
    ...projects,
    ...repositoryApi(client, projects.projects.get),
    ...mergeRequestsApi(client),
  };
}

export type Gitlab = ReturnType<typeof gitlabApi>;

export const createGitlab = (opts: ClientOptions): Gitlab => gitlabApi(createGitlabClient(opts));
