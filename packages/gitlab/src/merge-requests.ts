import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";
import { type ProjectRef, projectPath } from "./projects";

const mergeRequest = z
  .object({
    id: z.number(),
    iid: z.number(),
    title: z.string(),
    description: z.string().nullish(),
    state: z.enum(["opened", "closed", "merged", "locked"]),
    source_branch: z.string(),
    target_branch: z.string(),
    web_url: z.string(),
    draft: z.boolean().optional(),
    sha: z.string().nullish(),
  })
  .transform((m) => ({
    id: m.id,
    iid: m.iid,
    title: m.title,
    description: m.description ?? "",
    state: m.state,
    sourceBranch: m.source_branch,
    targetBranch: m.target_branch,
    webUrl: m.web_url,
    draft: m.draft ?? false,
    /** Head commit of the source branch. */
    sha: m.sha ?? null,
  }));
export type MergeRequest = z.output<typeof mergeRequest>;

const note = z
  .object({ id: z.number(), body: z.string(), system: z.boolean().optional() })
  .transform((n) => ({ id: n.id, body: n.body, system: n.system ?? false }));
export type Note = z.output<typeof note>;

export interface CreateMergeRequest {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
  removeSourceBranch?: boolean;
}

export interface UpdateMergeRequest {
  title?: string;
  description?: string;
  targetBranch?: string;
  /** Close or reopen; merging is deliberately not offered. */
  state?: "closed" | "opened";
}

export function mergeRequestsApi(client: GitlabClient) {
  const mrPath = (p: ProjectRef, iid: number) => `${projectPath(p)}/merge_requests/${iid}`;
  return {
    mergeRequests: {
      /** A 409 `conflict` means an open MR for this source branch already exists. */
      async create(project: ProjectRef, input: CreateMergeRequest) {
        const raw = await client.request("POST", `${projectPath(project)}/merge_requests`, {
          body: {
            source_branch: input.sourceBranch,
            target_branch: input.targetBranch,
            title: input.title,
            description: input.description,
            remove_source_branch: input.removeSourceBranch,
          },
        });
        return decode(mergeRequest, raw, "merge request");
      },
      async get(project: ProjectRef, iid: number) {
        return decode(
          mergeRequest,
          await client.request("GET", mrPath(project, iid)),
          "merge request",
        );
      },
      async update(project: ProjectRef, iid: number, input: UpdateMergeRequest) {
        const raw = await client.request("PUT", mrPath(project, iid), {
          body: {
            title: input.title,
            description: input.description,
            target_branch: input.targetBranch,
            state_event:
              input.state === "closed" ? "close" : input.state === "opened" ? "reopen" : undefined,
          },
        });
        return decode(mergeRequest, raw, "merge request");
      },
      async createNote(project: ProjectRef, iid: number, body: string) {
        const raw = await client.request("POST", `${mrPath(project, iid)}/notes`, {
          body: { body },
        });
        return decode(note, raw, "note");
      },
      async updateNote(project: ProjectRef, iid: number, noteId: number, body: string) {
        const raw = await client.request("PUT", `${mrPath(project, iid)}/notes/${noteId}`, {
          body: { body },
        });
        return decode(note, raw, "note");
      },
    },
  };
}
