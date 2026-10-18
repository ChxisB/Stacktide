import { call, session } from "./api";
import { CliError, type Command, parse, say } from "./cli";
import { every, onlyOrNamed, resolveProject } from "./target";

const USAGE = "usage: orch pipeline detect [options] | orch pipeline setup <template> [options]";
const FILE = ".gitlab-ci.yml";
/** The API's rule for a template parameter's name. */
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SHOWN = 3;

const MODES = ["inline", "include"] as const;

/** `name=value` from `--param` (text) or `--param-json` (a number or true/false), as the one map the API takes. */
function paramsOf(text: string[], json: string[]) {
  const params: Record<string, string | number | boolean> = {};
  const add = (raw: string, flag: string, read: (value: string) => string | number | boolean) => {
    const at = raw.indexOf("=");
    const name = at === -1 ? raw : raw.slice(0, at);
    // a value may be anything, so no message repeats it
    if (at === -1 || !PARAM_NAME.test(name)) {
      throw new CliError(`${flag} takes name=value, with a name of letters, digits and _`, 2);
    }
    if (Object.hasOwn(params, name)) throw new CliError(`parameter ${name} is given twice`, 2);
    params[name] = read(raw.slice(at + 1));
  };
  for (const raw of text) add(raw, "--param", (v) => v);
  for (const raw of json) {
    add(raw, "--param-json", (v) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        // falls through to the same error
      }
      if (typeof parsed !== "number" && typeof parsed !== "boolean") {
        throw new CliError("--param-json takes a number, true or false; give text with --param", 2);
      }
      return parsed;
    });
  }
  return params;
}

interface Preview {
  text: string;
  renderedHash: string;
  existing: string;
  mode: string;
  template: { name: string; version: string };
  validation: {
    ok: boolean;
    lint: { valid: boolean; errors: string[]; warnings: string[] };
    missingVariables: { environment: string | null; keys: string[] }[];
    violations: { rule: string; message: string }[];
  };
}

const WOULD: Record<string, string> = {
  none: `would add ${FILE}`,
  identical: `${FILE} already matches`,
  generated: `would update the generated ${FILE}`,
  "hand-written": `would replace the hand-written ${FILE} (the merge request says so)`,
};

/** What a preview says, as lines for stderr; the file itself is `text`. */
function previewLines(label: string, p: Preview) {
  const { lint, missingVariables } = p.validation;
  const lines = [
    `${label}: ${p.template.name} ${p.template.version}, ${p.mode}: ${WOULD[p.existing] ?? p.existing}`,
  ];
  for (const w of lint.warnings.slice(0, SHOWN)) lines.push(`warning: GitLab's lint: ${w}`);
  if (lint.warnings.length > SHOWN) lines.push(`warning: and ${lint.warnings.length - SHOWN} more`);
  if (missingVariables.length > 0) {
    const where = missingVariables.map(
      (m) => `${m.environment ?? "project"}: ${m.keys.join(", ")}`,
    );
    lines.push(`warning: variables the pipeline needs that are not set: ${where.join("; ")}`);
  }
  return lines;
}

const OUTCOME: Record<string, string> = {
  opened: "opened merge request",
  updated: "updated merge request",
  unchanged: "merge request already up to date:",
  in_place: `${FILE} on the default branch already matches, nothing to do`,
};

/**
 * `orch pipeline detect` shows what suits a project and what it was set up with; `orch pipeline
 * setup <template>` previews the pipeline, asks, and has the API open one merge request for it
 * (PIPE-6): nothing is committed to the default branch. `--dry-run` stops after the preview and
 * prints the file; `--yes` is for scripts. Missing variables and lint warnings are shown, and do not
 * stop it, as in the API; a pipeline GitLab's lint refuses, or one that breaks a guardrail (POL-4), does.
 */
export function pipelineCommands(): Record<string, Command> {
  return {
    pipeline: {
      summary:
        "see which CI templates suit a project, or open a merge request that sets one up: orch pipeline detect|setup <template>",
      async run(ctx, args) {
        const { values, positionals } = parse(args, {
          "api-url": { type: "string" },
          org: { type: "string" },
          project: { type: "string" },
          connection: { type: "string" },
          version: { type: "string" },
          param: { type: "string", multiple: true },
          "param-json": { type: "string", multiple: true },
          environment: { type: "string", multiple: true },
          mode: { type: "string" },
          "include-project": { type: "string" },
          "include-ref": { type: "string" },
          "dry-run": { type: "boolean" },
          yes: { type: "boolean" },
        });
        const [step, template, ...extra] = positionals;
        const detecting = step === "detect" && template === undefined;
        const setting = step === "setup" && template !== undefined && extra.length === 0;
        if (!detecting && !setting) throw new CliError(USAGE, 2);

        const { apiUrl, client } = await session(ctx, values["api-url"]);
        const project = await resolveProject(ctx, apiUrl, client, values);
        const scope = client
          .organizations({ orgId: project.orgId })
          .projects({ projectId: project.projectId });

        if (detecting) {
          const { config, recommendations } = await call(apiUrl, () => scope.pipeline.get());
          const lines = [
            config
              ? `${project.label}: set up with ${config.template} ${config.version} (${config.mode})${config.mrUrl ? `, merge request ${config.mrUrl}` : ""}`
              : `${project.label}: no pipeline set up`,
          ];
          if (recommendations.length === 0) lines.push("no template suits this project");
          else {
            lines.push("suits this project:");
            for (const r of recommendations) {
              lines.push(`  ${r.template} ${r.version}  ${r.confidence}  ${r.reason}`);
            }
          }
          say(ctx, lines.join("\n"), { config, recommendations });
          return;
        }

        const mode = values.mode ?? (values["include-project"] ? "include" : undefined);
        if (mode !== undefined && !MODES.some((m) => m === mode)) {
          throw new CliError(`unknown mode '${mode}'; use ${MODES.join(" or ")}`, 2);
        }
        if (values["include-ref"] && !values["include-project"]) {
          throw new CliError("--include-ref needs --include-project", 2);
        }
        if (mode === "include" && !values["include-project"]) {
          throw new CliError("--mode include needs --include-project", 2);
        }
        if (mode === "inline" && values["include-project"]) {
          throw new CliError("--include-project goes with --mode include", 2);
        }
        const params = paramsOf(values.param ?? [], values["param-json"] ?? []);
        const connectionId = await onlyOrNamed(
          "GitLab connection",
          "--connection",
          values.connection,
          () =>
            every(apiUrl, (cursor) =>
              client
                .organizations({ orgId: project.orgId })
                .connections.get({ query: { limit: 100, cursor } }),
            ).then((all) => all.filter((c) => c.type === "gitlab")),
        );
        const include = values["include-project"]
          ? {
              project: values["include-project"],
              ...(values["include-ref"] ? { ref: values["include-ref"] } : {}),
            }
          : undefined;
        const body = {
          connectionId,
          template: template as string,
          ...(values.version ? { version: values.version } : {}),
          ...(Object.keys(params).length > 0 ? { params } : {}),
          ...(values.environment?.length ? { environments: values.environment } : {}),
          ...(mode ? { mode: mode as (typeof MODES)[number] } : {}),
          ...(include ? { include } : {}),
        };

        const preview: Preview = await call(apiUrl, () => scope.pipeline.preview.post(body));
        const { lint } = preview.validation;
        if (!lint.valid) {
          const shown = lint.errors.slice(0, SHOWN).join("; ");
          throw new CliError(
            `GitLab's lint refuses this pipeline: ${shown}${lint.errors.length > SHOWN ? `; and ${lint.errors.length - SHOWN} more` : ""}`,
          );
        }
        const { violations } = preview.validation;
        if (violations.length > 0) {
          const shown = violations.slice(0, SHOWN).map((v) => `${v.rule}: ${v.message}`);
          throw new CliError(
            `the pipeline breaks a guardrail: ${shown.join("; ")}${violations.length > SHOWN ? `; and ${violations.length - SHOWN} more` : ""}`,
          );
        }
        for (const line of previewLines(project.label, preview)) ctx.io.err(line);
        if (values["dry-run"]) {
          say(ctx, preview.text.trimEnd(), { dryRun: true, ...preview });
          return;
        }
        // an identical file needs no merge request, so there is nothing to ask about
        if (
          preview.existing !== "identical" &&
          !values.yes &&
          !(await ctx.confirm(`Open a merge request for ${project.label}?`))
        ) {
          throw new CliError("cancelled; nothing was changed");
        }

        const done = await call(apiUrl, () => scope.pipeline.post(body));
        const what = OUTCOME[done.outcome] ?? done.outcome;
        const mr = done.mr ? ` !${done.mr.iid} ${done.mr.url}` : "";
        say(ctx, `${project.label}: ${what}${done.outcome === "in_place" ? "" : mr}`, done);
      },
    },
  };
}
