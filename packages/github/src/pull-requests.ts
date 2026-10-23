import { type Gitlab, GitlabError, type MergeRequest, type ProjectRef } from "@orch/gitlab";
import { z } from "zod";
import type { GithubClient } from "./client";
import { decode } from "./decode";
import { fullName, segments, whole } from "./paths";

const pull = z
  .object({
    id: z.number(),
    number: z.number(),
    title: z.string(),
    body: z.string().nullish(),
    state: z.enum(["open", "closed"]),
    merged: z.boolean().optional(),
    merged_at: z.string().nullish(),
    draft: z.boolean().optional(),
    html_url: z.string(),
    head: z.object({ ref: z.string(), sha: z.string().nullish() }),
    base: z.object({ ref: z.string() }),
    mergeable_state: z.string().nullish(),
  })
  .transform(
    (p): MergeRequest => ({
      id: p.id,
      iid: p.number,
      title: p.title,
      description: p.body ?? "",
      // GitHub has no "merged" state: a closed pull request that was merged says so in `merged`/`merged_at`
      state: p.merged === true || p.merged_at ? "merged" : p.state === "open" ? "opened" : "closed",
      sourceBranch: p.head.ref,
      targetBranch: p.base.ref,
      webUrl: p.html_url,
      draft: p.draft ?? false,
      sha: p.head.sha ?? null,
      // Only what GitHub says is clean counts as mergeable; "unknown" (not worked out yet, and absent from lists) is null.
      mergeStatus:
        p.mergeable_state === "clean" || p.mergeable_state === "has_hooks"
          ? "mergeable"
          : p.mergeable_state && p.mergeable_state !== "unknown"
            ? p.mergeable_state
            : null,
    }),
  );

const comment = z
  .object({
    id: z.number(),
    body: z.string(),
    issue_url: z.string().optional(),
    user: z.object({ id: z.number() }).nullish(),
  })
  .transform((c) => ({
    id: c.id,
    body: c.body,
    system: false,
    authorId: c.user?.id ?? null,
    issueUrl: c.issue_url,
  }));

const review = z.object({
  user: z.object({ id: z.number() }).nullish(),
  state: z.string(),
  commit_id: z.string().nullish(),
});

const protection = z.object({ required_approving_review_count: z.number() });
const rules = z.array(
  z.object({
    type: z.string(),
    parameters: z.object({ required_approving_review_count: z.number() }).optional(),
  }),
);

export function pullRequestsApi(
  client: GithubClient,
  base: (p: ProjectRef) => Promise<string>,
  getProject: Gitlab["projects"]["get"],
): Pick<Gitlab, "mergeRequests"> {
  /** A comment, only if it belongs to this pull request: a comment id alone names any issue's comment. */
  async function ownComment(root: string, iid: number, noteId: number) {
    const c = decode(
      comment,
      await client.request("GET", `${root}/issues/comments/${whole(noteId)}`),
      "comment",
    );
    if (!c.issueUrl?.endsWith(`/issues/${whole(iid)}`)) {
      throw new GitlabError("not_found", "No such note on this pull request");
    }
    return c;
  }
  /**
   * The approving reviews a branch's protection asks for. Only a token that can administer the repository may read it;
   * the two 404s that mean "none asked for" are told from the 404 GitHub gives a token that may not look.
   */
  async function protectionCount(root: string, branch: string) {
    try {
      const raw = await client.request(
        "GET",
        `${root}/branches/${branch}/protection/required_pull_request_reviews`,
      );
      return decode(protection, raw, "branch protection").required_approving_review_count;
    } catch (e) {
      if (
        e instanceof GitlabError &&
        e.kind === "not_found" &&
        /not protected|not enabled/i.test(e.message)
      ) {
        return 0;
      }
      throw e;
    }
  }
  async function rulesetCount(root: string, branch: string) {
    const raw = await client.request("GET", `${root}/rules/branches/${branch}`);
    return Math.max(
      0,
      ...decode(rules, raw, "branch rules").map((r) =>
        r.type === "pull_request" ? (r.parameters?.required_approving_review_count ?? 0) : 0,
      ),
    );
  }
  const note = ({ issueUrl: _, ...n }: z.output<typeof comment>) => n;

  const get = async (project: ProjectRef, iid: number) =>
    decode(
      pull,
      await client.request("GET", `${await base(project)}/pulls/${whole(iid)}`),
      "pull request",
    );

  async function* list(
    project: ProjectRef,
    o: { sourceBranch?: string; targetBranch?: string; state?: MergeRequest["state"] } = {},
  ) {
    const root = await base(project);
    const owner = fullName(
      typeof project === "string" ? project : (await getProject(project)).path,
    ).split("/")[0];
    const query = {
      // GitHub has no "locked" state: that query finds nothing, whatever it asks for
      state: o.state === undefined ? "all" : o.state === "opened" ? "open" : "closed",
      head: o.sourceBranch === undefined ? undefined : `${owner}:${o.sourceBranch}`,
      base: o.targetBranch,
      sort: "created",
      direction: "desc",
      per_page: 100,
    };
    for await (const raw of client.paginate(`${root}/pulls`, query)) {
      const p = decode(pull, raw, "pull request");
      // GitHub's "closed" holds the merged ones too
      if (o.state === undefined || p.state === o.state) yield p;
    }
  }

  return {
    mergeRequests: {
      async create(project, input) {
        const root = await base(project);
        // GitHub answers a duplicate with 422; the contract (and the caller) wants `conflict`
        for await (const _ of list(project, {
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
          state: "opened",
        })) {
          throw new GitlabError(
            "conflict",
            "An open pull request for this branch exists already",
            409,
          );
        }
        // shortcut: `removeSourceBranch` has no per-pull-request switch on GitHub (a repository setting); ignored.
        const raw = await client.request("POST", `${root}/pulls`, {
          body: {
            title: input.title,
            head: input.sourceBranch,
            base: input.targetBranch,
            body: input.description,
          },
        });
        return decode(pull, raw, "pull request");
      },
      list,
      get,
      /**
       * GitHub has no single "approved" (forge-seam section 4): the reviews are reduced to the latest word of each person
       * and set against what the target branch requires, from its protection and its rulesets, whichever asks for more.
       * Fail closed: a source that cannot be read is an error, never "approved".
       * shortcut: an approval counts only on the pull request's current head, and a read-only collaborator's counts
       * though GitHub's own rule would not count it; `mergeStatus` ("clean") is GitHub's own answer and the caller
       * asks for it too. Code owners' required reviews are not read. Upgrade by reading `reviewDecision` (GraphQL).
       */
      async approvals(project, iid) {
        const root = await base(project);
        const pr = await get(project, iid);
        const branch = segments(pr.targetBranch);
        const standing = new Map<number, "approved" | "blocking" | "none">();
        for await (const raw of client.paginate(`${root}/pulls/${whole(iid)}/reviews`, {
          per_page: 100,
        })) {
          const r = decode(review, raw, "review");
          if (!r.user) continue;
          // oldest first, so the last word of a person is the one that stays; a comment or a word not known says nothing
          if (r.state === "APPROVED")
            standing.set(r.user.id, r.commit_id === pr.sha ? "approved" : "none");
          else if (r.state === "CHANGES_REQUESTED") standing.set(r.user.id, "blocking");
          else if (r.state === "DISMISSED") standing.set(r.user.id, "none");
        }
        const states = [...standing.values()];
        const required = Math.max(
          await protectionCount(root, branch),
          await rulesetCount(root, branch),
        );
        return {
          approved:
            !states.includes("blocking") &&
            states.filter((x) => x === "approved").length >= required,
        };
      },
      async update(project, iid, input) {
        const raw = await client.request("PATCH", `${await base(project)}/pulls/${whole(iid)}`, {
          body: {
            title: input.title,
            body: input.description,
            base: input.targetBranch,
            state:
              input.state === undefined ? undefined : input.state === "closed" ? "closed" : "open",
          },
        });
        return decode(pull, raw, "pull request");
      },
      async getNote(project, iid, noteId) {
        return note(await ownComment(await base(project), iid, noteId));
      },
      async createNote(project, iid, body) {
        const raw = await client.request(
          "POST",
          `${await base(project)}/issues/${whole(iid)}/comments`,
          { body: { body } },
        );
        return note(decode(comment, raw, "comment"));
      },
      async updateNote(project, iid, noteId, body) {
        const root = await base(project);
        await ownComment(root, iid, noteId);
        const raw = await client.request("PATCH", `${root}/issues/comments/${whole(noteId)}`, {
          body: { body },
        });
        return note(decode(comment, raw, "comment"));
      },
    },
  };
}
