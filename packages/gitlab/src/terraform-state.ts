import type { GitlabClient } from "./client";
import { GitlabError } from "./errors";
import { type ProjectRef, projectPath } from "./projects";

export function terraformStateApi(client: GitlabClient) {
  return {
    terraformState: {
      /**
       * The newest version of the project's GitLab-managed Terraform state `name`, as the text GitLab holds. `missing`
       * when there is none (GitLab says 404 for a project that is not there too); `too_large` when it is longer
       * than `maxBytes`, which is then not read. GitLab asks the Maintainer role for this. The text is a state:
       * secrets in clear, never to be logged.
       */
      async get(project: ProjectRef, name: string, maxBytes: number) {
        try {
          const r = await client.download(
            `${projectPath(project)}/terraform/state/${encodeURIComponent(name)}`,
            { maxBytes },
          );
          return "text" in r
            ? { status: "ok" as const, text: r.text }
            : { status: "too_large" as const };
        } catch (e) {
          if (e instanceof GitlabError && e.kind === "not_found") {
            return { status: "missing" as const };
          }
          throw e;
        }
      },
    },
  };
}
