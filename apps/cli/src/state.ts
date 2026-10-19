import { call, session } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { every, gitlabConnectionOf, resolveProject } from "./target";

const USAGE =
  "usage: orch state import <stack> [--connection <c>] [--yes] [options] | orch state ls <stack> [options] | orch state resources <stack> [--type <t>] [--provider <p>] [--module <m>] [options]";

/** The flags that belong to one step only: a step that is given another's is a mistake, not something to ignore. */
const ONLY = {
  import: ["connection", "yes"],
  ls: [],
  resources: ["type", "provider", "module"],
} as const;

/** Said after an import: what it was, and what is still the user's to do. */
const NEXT = [
  "this is a copy, taken once: GitLab's state is untouched, and a change applied with GitLab-managed state after this is not in the copy",
  "stop applies of this stack that use GitLab's state, then point the stack at the platform (state: orch) in a merge request",
];

/** A lineage, an address or a name is whatever a job wrote: a control character in one must not reach someone else's terminal. */
const plain = (text: string) => text.replace(/[\p{Cc}\p{Cf}]/gu, " ");

export const stateCommands = (): Record<string, Command> => ({
  state: {
    summary:
      "Terraform state kept by the platform: orch state import <stack> (copy what GitLab holds), ls <stack> (its versions), resources <stack> (what it holds, by name)",
    async run(ctx, args) {
      const { values, positionals } = parse(args, {
        "api-url": { type: "string" },
        org: { type: "string" },
        project: { type: "string" },
        connection: { type: "string" },
        yes: { type: "boolean" },
        type: { type: "string" },
        provider: { type: "string" },
        module: { type: "string" },
      });
      const [step, stack, ...extra] = positionals;
      if (
        (step !== "import" && step !== "ls" && step !== "resources") ||
        !stack ||
        extra.length > 0
      ) {
        throw new CliError(USAGE, 2);
      }
      const own: readonly string[] = ONLY[step];
      const foreign = Object.values(ONLY)
        .flat()
        .filter((f) => !own.includes(f));
      if (foreign.some((f) => values[f as keyof typeof values] !== undefined)) {
        throw new CliError(USAGE, 2);
      }

      const { apiUrl, client } = await session(ctx, values["api-url"]);
      const target = await resolveProject(ctx, apiUrl, client, values);
      const state = client
        .organizations({ orgId: target.orgId })
        .projects({ projectId: target.projectId })
        .state({ stack });

      if (step === "ls") {
        const versions = await call(apiUrl, () => state.versions.get());
        const lines = versions.map(
          (v) =>
            `serial ${v.serial}  ${new Date(v.createdAt).toISOString()}  ${v.sizeBytes} bytes  ${v.createdBy}`,
        );
        say(ctx, lines.length > 0 ? lines.join("\n") : `no state for ${stack} in ${target.label}`, {
          project: target.label,
          stack,
          versions,
        });
        return;
      }

      if (step === "resources") {
        const resources = await every(apiUrl, (cursor) =>
          state.resources.get({
            query: {
              limit: 100,
              cursor,
              ...(values.type !== undefined && { type: values.type }),
              ...(values.provider !== undefined && { provider: values.provider }),
              ...(values.module !== undefined && { module: values.module }),
            },
          }),
        );
        say(
          ctx,
          resources.length > 0
            ? resources.map((r) => plain(r.address)).join("\n")
            : `no resources in ${stack} in ${target.label}`,
          { project: target.label, stack, resources },
        );
        return;
      }

      const connectionId = await gitlabConnectionOf(
        apiUrl,
        client,
        target.orgId,
        values.connection,
      );
      if (
        !values.yes &&
        !(await ctx.confirm(
          `Copy the Terraform state GitLab holds for ${stack} into ${target.label}? GitLab's copy is not changed.`,
        ))
      ) {
        throw new CliError("cancelled; nothing was changed");
      }
      const r = await call(apiUrl, () => state.import.post({ connectionId }));
      say(
        ctx,
        `imported ${stack} in ${target.label}: serial ${r.serial}, ${r.resources} ${r.resources === 1 ? "resource" : "resources"}, ${r.sizeBytes} bytes`,
        { project: target.label, stack, ...r },
      );
      if (!ctx.json) for (const line of NEXT) ctx.io.err(line);
    },
  },
});
