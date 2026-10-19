import { FINDING_STATUSES } from "@orch/core";
import { call, session } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { every, resolveProject } from "./target";

const USAGE =
  "usage: orch findings ls [--status open|dismissed|resolved] [options] | orch findings dismiss <ID> --reason <text> [options] | orch findings reopen <ID> [options]";

/** Said whenever a finding is shown as open or dismissed: the platform cannot revoke a secret, and dismissing one only stops it being counted. */
const REVOKE =
  "a finding is a secret that was in the repository: revoke or rotate it at its source";

/** A reason is a person's free text, and a path or branch name is whatever the repository holds: a control character in any must not reach someone else's terminal. */
const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");

export const findingsCommands = (): Record<string, Command> => ({
  findings: {
    summary:
      "secret findings of a project: orch findings ls|dismiss|reopen (a finding must be revoked at its source; dismissing only stops it being counted)",
    async run(ctx, args) {
      const { values, positionals } = parse(args, {
        "api-url": { type: "string" },
        org: { type: "string" },
        project: { type: "string" },
        status: { type: "string" },
        reason: { type: "string" },
      });
      const [step, id, ...extra] = positionals;
      const known = step === "ls" || step === "dismiss" || step === "reopen";
      if (!known || extra.length > 0 || (step === "ls") !== (id === undefined)) {
        throw new CliError(USAGE, 2);
      }
      if (
        (step !== "ls" && values.status !== undefined) ||
        (step !== "dismiss" && values.reason !== undefined)
      ) {
        throw new CliError(USAGE, 2);
      }
      // checked before anything is looked up, so a mistake costs no request
      const status = FINDING_STATUSES.find((s) => s === values.status);
      if (values.status !== undefined && !status) {
        throw new CliError(`--status is one of ${FINDING_STATUSES.join(", ")}`, 2);
      }
      const reason = values.reason?.trim();
      if (step === "dismiss" && !reason) throw new CliError("--reason is needed", 2);

      const { apiUrl, client } = await session(ctx, values["api-url"]);
      const target = await resolveProject(ctx, apiUrl, client, values);
      const findings = client
        .organizations({ orgId: target.orgId })
        .projects({ projectId: target.projectId }).findings;

      if (step === "ls") {
        const all = await every(apiUrl, (cursor) =>
          findings.get({ query: { limit: 100, cursor, ...(status ? { status } : {}) } }),
        );
        const lines = all.map((f) => {
          const where = `${f.path}${f.line === null ? "" : `:${f.line}`}`;
          const by = f.dismissedBy
            ? `  by ${plain(f.dismissedBy)}: ${plain(f.dismissedReason ?? "")}`
            : "";
          return `${f.id}  ${f.status}  ${f.severity}  ${plain(f.rule)}  ${plain(where)}  ${plain(f.ref)}${by}`;
        });
        say(ctx, lines.length > 0 ? lines.join("\n") : `no findings in ${target.label}`, {
          target: target.label,
          findings: all,
        });
        if (!ctx.json && all.some((f) => f.status === "open")) ctx.io.err(REVOKE);
      } else if (step === "dismiss" && id && reason) {
        await call(apiUrl, () => findings({ findingId: id }).dismiss.post({ reason }));
        say(ctx, `dismissed finding ${id} in ${target.label}`, {
          target: target.label,
          dismissed: id,
        });
        if (!ctx.json) ctx.io.err(`dismissing does not revoke the secret: ${REVOKE}`);
      } else if (id) {
        await call(apiUrl, () => findings({ findingId: id }).reopen.post());
        say(ctx, `reopened finding ${id} in ${target.label}`, {
          target: target.label,
          reopened: id,
        });
      }
    },
  },
});
