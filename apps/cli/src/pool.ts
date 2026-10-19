import { call, session } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { every, gitlabConnectionOf, idOf, resolveOrganization, resolveProject } from "./target";

const USAGE =
  "usage: orch pool ls [--status [--project <p>] [--connection <c>]] | orch pool add <name> --tag <tag> [--tag <tag>...] [--image <ref>] [--disabled] [--default] | orch pool rm <name> | orch pool default <name> | orch pool default --clear [options]";

/** Said when a pool is made: the platform can say where a job should go, GitLab decides who may take it. */
const REMINDER =
  "tags are routing, not isolation: whoever can register a runner with these tags in GitLab receives these jobs, and the credentials they are given";

/** What `unknown` means, in words; none of GitLab's own text is kept. */
const WHY = {
  not_permitted: "the connection's token cannot list the project's runners",
  unlinked: "the project is not on GitLab",
  unavailable: "GitLab did not answer",
} as const;

/** The flags each step takes besides `--org` and `--api-url`: a flag that does nothing is a mistake, not a no-op. */
const FLAGS = {
  ls: ["status", "project", "connection"],
  add: ["tag", "image", "disabled", "default"],
  rm: [],
  default: ["clear"],
} as const;

export const poolCommands = (): Record<string, Command> => ({
  pool: {
    summary:
      "worker pools, the runner tags a stack's jobs ask for: orch pool ls|add|rm|default (tags route jobs, they do not isolate them)",
    async run(ctx, args) {
      const { values, positionals } = parse(args, {
        "api-url": { type: "string" },
        org: { type: "string" },
        project: { type: "string" },
        connection: { type: "string" },
        status: { type: "boolean" },
        tag: { type: "string", multiple: true },
        image: { type: "string" },
        disabled: { type: "boolean" },
        default: { type: "boolean" },
        clear: { type: "boolean" },
      });
      const [step, name, ...extra] = positionals;
      if (step !== "ls" && step !== "add" && step !== "rm" && step !== "default") {
        throw new CliError(USAGE, 2);
      }
      const given = Object.keys(values).filter((k) => k !== "api-url" && k !== "org");
      const allowed: readonly string[] = FLAGS[step];
      const wantsName = step === "ls" ? false : !(step === "default" && values.clear);
      if (
        extra.length > 0 ||
        given.some((k) => !allowed.includes(k)) ||
        (wantsName ? name === undefined : name !== undefined) ||
        (step === "add" && !values.tag?.length) ||
        (step === "ls" &&
          (values.project !== undefined || values.connection !== undefined) &&
          !values.status)
      ) {
        throw new CliError(USAGE, 2);
      }

      const { apiUrl, client } = await session(ctx, values["api-url"]);
      // --status asks about one project's runners, so it names a project; the rest is about the organization
      const target = values.status
        ? await resolveProject(ctx, apiUrl, client, values)
        : { ...(await resolveOrganization(ctx, apiUrl, client, values)), projectId: undefined };
      const org = client.organizations({ orgId: target.orgId });
      const label = values.org ?? target.label.split("/")[0] ?? target.label;
      const all = () => every(apiUrl, (cursor) => org.pools.get({ query: { limit: 100, cursor } }));
      const poolId = (ref: string) => idOf("pool", ref, all);

      if (step === "ls") {
        const pools = await all();
        const connectionId = target.projectId
          ? await gitlabConnectionOf(apiUrl, client, target.orgId, values.connection)
          : undefined;
        const shown = [];
        // every answer is in before anything is printed, so a refusal halfway leaves no half a list
        for (const p of pools) {
          const health =
            target.projectId && connectionId
              ? await call(apiUrl, () =>
                  org
                    .projects({ projectId: target.projectId as string })
                    .pools({ poolId: p.id })
                    .status.get({ query: { connectionId } }),
                )
              : undefined;
          shown.push({ ...p, ...(health ? { health } : {}) });
        }
        const lines = shown.map((p) => {
          const h = p.health;
          const state = !h
            ? ""
            : h.state === "unknown"
              ? `  unknown (${h.reason ? WHY[h.reason] : "not known"})`
              : `  ${h.state} (${h.online} of ${h.total} online)`;
          return `${p.name}  tags ${p.tags.join(",")}  image ${p.image ?? "-"}  ${p.enabled ? "enabled" : "disabled"}${p.isDefault ? "  default" : ""}${state}`;
        });
        say(ctx, lines.length > 0 ? lines.join("\n") : `no pools in ${label}`, {
          org: label,
          ...(target.projectId ? { project: target.label } : {}),
          pools: shown,
        });
      } else if (step === "add" && name) {
        const pool = await call(apiUrl, () =>
          org.pools.post({
            name,
            tags: values.tag ?? [],
            ...(values.image !== undefined ? { image: values.image } : {}),
            ...(values.disabled ? { enabled: false } : {}),
            ...(values.default ? { isDefault: true } : {}),
          }),
        );
        say(ctx, `added pool ${pool.name} in ${label} (tags ${pool.tags.join(",")})`, {
          org: label,
          pool,
        });
        if (!ctx.json) ctx.io.err(REMINDER);
      } else if (step === "rm" && name) {
        const id = await poolId(name);
        await call(apiUrl, () => org.pools({ poolId: id }).delete());
        say(ctx, `removed pool ${name} from ${label}`, { org: label, removed: name });
      } else if (name) {
        const id = await poolId(name);
        await call(apiUrl, () => org.pools({ poolId: id }).patch({ isDefault: true }));
        say(ctx, `${name} is the default pool of ${label}`, { org: label, default: name });
      } else {
        const current = (await all()).find((p) => p.isDefault);
        if (current) {
          await call(apiUrl, () => org.pools({ poolId: current.id }).patch({ isDefault: false }));
        }
        say(ctx, `${label} has no default pool`, { org: label, default: null });
      }
    },
  },
});
