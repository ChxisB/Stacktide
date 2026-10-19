import { call, session } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { gitlabConnectionOf, resolveOrganization } from "./target";

const USAGE = "usage: orch template ls --catalog <group/project> [options]";
const STANDING = {
  up_to_date: "up to date",
  behind: "behind the latest release",
  unpinned: "follows no release",
  unpublished: "its release is not published",
} as const;

/**
 * `orch template ls --catalog <group/project>` shows what a GitLab CI/CD Catalog project publishes
 * (CMP-4): its releases, its components with their inputs, and which of the organization's projects
 * use it and whether they are behind (CMP-5). It only reads. To move a project to a newer release,
 * run `orch pipeline setup <template> --mode component --include-project <catalog> --include-ref <release>`.
 */
export function templateCommands(): Record<string, Command> {
  return {
    template: {
      summary:
        "see what a catalog project publishes and who uses it: orch template ls --catalog <group/project>",
      async run(ctx, args) {
        const { values, positionals } = parse(args, {
          "api-url": { type: "string" },
          org: { type: "string" },
          catalog: { type: "string" },
          connection: { type: "string" },
        });
        if (positionals.length !== 1 || positionals[0] !== "ls" || !values.catalog) {
          throw new CliError(USAGE, 2);
        }
        const { apiUrl, client } = await session(ctx, values["api-url"]);
        const org = await resolveOrganization(ctx, apiUrl, client, values);
        const connectionId = await gitlabConnectionOf(apiUrl, client, org.orgId, values.connection);
        const r = await call(apiUrl, () =>
          client.organizations({ orgId: org.orgId })["template-registry"].get({
            query: { project: values.catalog as string, connectionId },
          }),
        );

        const lines = [
          r.latest === null
            ? `${r.project}: no releases (a release is a tag such as 1.2.3)`
            : `${r.project}: ${r.releases.length} release${r.releases.length === 1 ? "" : "s"}, latest ${r.latest}${r.truncated ? " (only the newest were read for the components)" : ""}`,
        ];
        for (const c of r.components) {
          const newest = c.versions[0] ?? "-";
          const older = c.versions.length > 1 ? ` (+${c.versions.length - 1} older)` : "";
          const inputs = c.inputs.map((i) => (i.required ? `${i.name}*` : i.name));
          lines.push(
            c.problem
              ? `  ${c.name}  ${newest}  cannot be read: ${c.problem}`
              : `  ${c.name}  ${newest}${older}  ${inputs.length === 0 ? "no inputs" : `inputs: ${inputs.join(", ")}`}`,
          );
        }
        if (r.consumers.length > 0) {
          lines.push("used by:");
          for (const c of r.consumers) {
            lines.push(
              `  ${c.projectName}  ${c.mode} ${c.ref ?? "no ref"}  ${STANDING[c.standing]}${c.standing === "behind" ? ` (${r.latest})` : ""}`,
            );
          }
        }
        say(ctx, lines.join("\n"), r);
      },
    },
  };
}
