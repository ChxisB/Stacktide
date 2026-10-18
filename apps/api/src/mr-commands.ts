import { can, DomainError, type Logger } from "@orch/core";
import { audit, describeError, latestRunOfMergeRequest } from "@orch/db";
import type { Gitlab } from "@orch/gitlab";
import { NAME, type Tool } from "@orch/iac";
import { z } from "zod";
import { inline } from "./mr-note";
import { type MrPlanConfig, planMergeRequest, plannedProject } from "./mr-plan";
import { hopeless, type RunDeps } from "./pipeline-runs";
import { applyRun } from "./run-apply";
import type { Roles } from "./session";
import type { JobHandler } from "./worker";

export interface CommandDeps extends RunDeps {
  /** What a GitLab user may do here (`gitlabRoles`): the commenter need not have signed in. */
  roles: (user: { gitlabId: number }) => Promise<Roles>;
  /** Image repository per tool that has no default (Terragrunt). */
  images?: Partial<Record<Tool, string>> | undefined;
  /** Left out when merge request plans are not set up: `orch plan` then says so. */
  config?: MrPlanConfig | undefined;
}

/** What a `gitlab.event` job says of a note: which one, never what it says or who wrote it. */
const noteEvent = z.looseObject({
  event: z.literal("note"),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  projectId: z.number().int().positive(),
  noteableType: z.literal("MergeRequest"),
  mrIid: z.number().int().positive(),
  noteId: z.number().int().positive(),
  action: z.string().optional(),
});

export type Command = { name: "plan" } | { name: "apply"; stack?: string };

// A note that means to be a command: it starts with `orch plan` or `orch apply`, in any case (so
// `Orch Plan` is told it was not understood, not ignored; `COMMAND` itself is lower case only).
// "orch seems slow" and "/orch apply" are talk (and GitLab's own quick actions), not commands.
const ADDRESSED = /^orch\s+(?:plan|apply)\b/i;
const COMMAND = /^orch (plan|apply)(?: (\S+))?$/;

/**
 * `orch plan`, `orch apply` or `orch apply <stack>`: the whole note, one line, single spaces,
 * lower case. `undefined` is a note that is not for us; `"unclear"` one that is but has more or
 * less than that (a second line may be a quick action, which GitLab would run), so nothing runs.
 */
export function parseCommand(body: string): Command | "unclear" | undefined {
  const text = body.trim();
  if (!ADDRESSED.test(text)) return undefined;
  const m = COMMAND.exec(text);
  if (!m) return "unclear";
  if (m[1] === "plan") return m[2] === undefined ? { name: "plan" } : "unclear";
  if (m[2] === undefined) return { name: "apply" };
  return NAME.test(m[2]) ? { name: "apply", stack: m[2] } : "unclear";
}

const NEEDS = {
  plan: { action: "run.create", what: "plan" },
  apply: { action: "run.apply", what: "apply" },
} as const;

/**
 * The `gitlab.event` consumer for notes (IAC-9): `orch plan` plans the merge request's newest
 * commit if no run has, `orch apply [stack]` applies the newest run's saved plans, as the person
 * who wrote the note. Replies are notes; none of them starts with a command, so they cannot be
 * mistaken for one.
 *
 * The event only names the note: the job reads it from GitLab, so the text and the author are
 * GitLab's own. A command runs when its note is written, not when it is edited. The author's roles come from GitLab
 * membership, as everywhere (`roles`), and `run.create` / `run.apply` decide, so applying needs
 * the same maintainer as the API's route. Whatever refuses an apply is said in a reply; roles that
 * cannot be read fail the job for a retry, never grant.
 */
export const mrCommandHandler =
  (deps: CommandDeps): JobHandler =>
  async (ctx) => {
    const parsed = noteEvent.safeParse(ctx.payload);
    // only a note when it is written: an edit (GitLab says `update`, as it does of our own notes
    // that are rewritten) does not run anything again
    if (!parsed.success || (parsed.data.action ?? "create") !== "create") return;
    const e = parsed.data;
    const project = await plannedProject(deps.db, e.organizationId, e.projectId);
    if (!project) return;
    const at = {
      organizationId: e.organizationId,
      projectId: project.id,
      gitlabProjectId: e.projectId,
    };
    try {
      const gitlab = await deps.gitlab(e.organizationId, e.connectionId);
      const note = await gitlab.mergeRequests.getNote(e.projectId, e.mrIid, e.noteId);
      // GitLab's own notes ("merged", "added 1 commit") are not people talking
      if (note.system || note.authorId === null) return;
      const command = parseCommand(note.body);
      if (command === undefined) return;

      const say = (text: string) => reply(gitlab, at, e.mrIid, text, ctx.log);
      const roles = await deps.roles({ gitlabId: note.authorId });
      const subject = { kind: "user", ...roles } as const;
      const resource = { organizationId: at.organizationId, projectId: at.projectId };
      // only people who can read the project are answered: anyone who can comment gets no bot notes
      const readable = can(subject, "run.read", resource);
      if (command === "unclear") {
        if (readable) {
          await say(
            "That was not understood, so nothing was done. Write one line, nothing else: `orch plan`, `orch apply` or `orch apply <stack>`.",
          );
        }
        return;
      }
      const need = NEEDS[command.name];
      if (!can(subject, need.action, resource)) {
        ctx.log.warn("merge request command refused", {
          gitlabUser: note.authorId,
          command: command.name,
        });
        if (readable) await say(`You are not allowed to ${need.what} this merge request.`);
        return;
      }

      const actor = { kind: "gitlab_user", id: String(note.authorId) };
      const before = await latestRunOfMergeRequest(
        deps.db,
        at.organizationId,
        at.projectId,
        e.mrIid,
      );
      if (command.name === "plan") {
        if (!deps.config) {
          await say(
            "Merge requests are not planned on this installation: it is not set up for it.",
          );
          return;
        }
        await planMergeRequest({ ...deps, config: deps.config }, gitlab, ctx, at, e.mrIid, actor);
        const after = await latestRunOfMergeRequest(
          deps.db,
          at.organizationId,
          at.projectId,
          e.mrIid,
        );
        await say(
          after && after.id !== before?.id
            ? "Planning started for the newest commit. The note above shows how it goes."
            : "Nothing new was planned: the newest commit already has a run, or no stack is affected by it.",
        );
        return;
      }

      if (!before) {
        await say("Nothing to apply: this merge request has not been planned.");
        return;
      }
      try {
        const started = await applyRun({ db: deps.db, log: ctx.log, images: deps.images }, gitlab, {
          at,
          run: before,
          stacks: command.stack === undefined ? undefined : [command.stack],
          when: "command",
          audit: (tx, event) =>
            audit(
              tx,
              { actor },
              { ...event, metadata: { ...event.metadata, via: "note", noteId: e.noteId } },
            ),
        });
        await say(`Apply started for ${inline(started.join(", "))}.`);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        ctx.log.warn("merge request apply refused", { code: error.code });
        await say(`Not applied: ${inline(error.message)}`);
      }
    } catch (error) {
      const why = hopeless(error, "the merge request, the note or the repository");
      if (!why) throw error;
      ctx.log.warn("note event dropped", { reason: why, connection: e.connectionId });
    }
  };

/** Best effort: what was asked has been done or refused whatever becomes of the reply. */
async function reply(
  gitlab: Gitlab,
  at: { gitlabProjectId: number },
  iid: number,
  text: string,
  log: Logger,
) {
  try {
    await gitlab.mergeRequests.createNote(at.gitlabProjectId, iid, text);
  } catch (error) {
    log.warn("could not reply to a merge request command", { error: describeError(error) });
  }
}
