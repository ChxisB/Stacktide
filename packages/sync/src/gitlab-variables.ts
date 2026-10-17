import { canMask, type Gitlab, GitlabError, isVariableKey, type VariableOwner } from "@orch/gitlab";
import { z } from "zod";
import { SyncError } from "./errors";
import { byKeyThenScope } from "./ref";
import type { Capabilities, ItemInput, ItemRef, Remote, RemoteItem, SyncAdapter } from "./types";

export const GITLAB_VARIABLES = "gitlab-variables";

/** GitLab refuses a longer value. The platform's own cap is higher, so a plan has to say so. */
const MAX_VALUE = 10_000;

const owner = z.union([z.number().int().positive(), z.string().min(1)]);
const configSchema = z.union([
  z.strictObject({ project: owner, protected: z.boolean().optional() }),
  z.strictObject({ group: owner, protected: z.boolean().optional() }),
]);

/**
 * Whose variables, by id or path: a project or a group (a group's `environment_scope` needs Premium).
 * `protected` marks every variable it writes as protected; left out, new ones are not and existing
 * ones keep what they have. The credential is not here: it belongs to the connection the `Gitlab`
 * client was made from.
 */
export type GitlabVariablesConfig = z.infer<typeof configSchema>;

/**
 * The config as stored: checked, and stripped of anything not in the shape. The error says what the
 * shape is and nothing of what was given, so a credential pasted into a config is never echoed.
 */
export function parseGitlabVariablesConfig(config: unknown): GitlabVariablesConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new SyncError(
      "invalid_config",
      "the config is { project } or { group }, an id or a path, and optionally { protected }",
    );
  }
  return parsed.data;
}

const label = ({ key, scope }: ItemRef) => `${JSON.stringify(key)} (${scope})`;

/** Fixed words, so nothing GitLab said, no value and no URL can reach an error. */
function failed(what: string, e: unknown) {
  const why =
    e instanceof GitlabError ? `GitLab answered ${e.kind}` : "the request could not be made";
  return new SyncError("failed", `${what}: ${why}`);
}

/**
 * GitLab CI/CD variables of one project or group as a sync target. Values are final when they get
 * here (the platform has resolved every reference), so they are always written `raw`. A secret is
 * written masked, never hidden, so the value stays readable and drift shows; one GitLab cannot mask
 * is `unmaskable`, never written plain. `gitlab` is the client of one connection.
 */
export function gitlabVariablesAdapter(
  gitlab: Pick<Gitlab, "variables">,
): SyncAdapter<GitlabVariablesConfig> {
  const capabilities: Capabilities = {
    canReadValues: true,
    supportsMasking: true,
    supportsScopes: true,
    supportsFiles: true,
  };

  const checkRef = (ref: ItemRef) => {
    if (!isVariableKey(ref.key)) {
      throw new SyncError(
        "invalid",
        `${JSON.stringify(ref.key.slice(0, 64))}: a GitLab variable key is 1-255 letters, digits or _`,
      );
    }
    if (!ref.scope) throw new SyncError("invalid", `${label(ref)}: the scope is empty`);
  };
  const check = (item: ItemInput) => {
    checkRef(item);
    if (item.value.length > MAX_VALUE) {
      throw new SyncError(
        "invalid",
        `${label(item)}: GitLab takes at most ${MAX_VALUE} characters`,
      );
    }
    if (item.secret && !canMask(item.value, { raw: true })) {
      throw new SyncError(
        "unmaskable",
        `${label(item)}: GitLab can only mask 8 or more characters on one line without spaces`,
      );
    }
  };

  return {
    type: GITLAB_VARIABLES,
    capabilities,
    check,
    validate: parseGitlabVariablesConfig,
    connect(config): Remote {
      const of: VariableOwner =
        "project" in config ? { project: config.project } : { group: config.group };
      const fields = (item: ItemInput) => ({
        value: item.value,
        type: item.file ? ("file" as const) : ("env_var" as const),
        masked: item.secret,
        raw: true,
        protected: config.protected,
        scope: item.scope,
      });
      const there = (ref: ItemRef) =>
        gitlab.variables.get(of, ref).then(
          () => true,
          (e: unknown) => {
            if (e instanceof GitlabError && e.kind === "not_found") return false;
            throw failed(label(ref), e);
          },
        );

      return {
        async read() {
          const items: RemoteItem[] = [];
          try {
            for await (const v of gitlab.variables.list(of)) {
              items.push({
                key: v.key,
                scope: v.scope,
                value: v.value,
                secret: v.masked,
                file: v.type === "file",
              });
            }
          } catch (e) {
            throw failed("reading the variables", e);
          }
          return items.sort(byKeyThenScope);
        },
        async create(item) {
          check(item);
          try {
            await gitlab.variables.create(of, item.key, fields(item));
          } catch (e) {
            // GitLab answers a taken key like any other refused body: ask which it was
            if (e instanceof GitlabError && (e.kind === "invalid" || e.kind === "conflict")) {
              if (await there(item)) {
                throw new SyncError("exists", `${label(item)} is already there`);
              }
              throw new SyncError("invalid", `${label(item)}: GitLab refused the variable`);
            }
            throw failed(label(item), e);
          }
        },
        async update(item) {
          check(item);
          try {
            await gitlab.variables.update(of, item, fields(item));
          } catch (e) {
            if (e instanceof GitlabError && e.kind === "not_found") {
              throw new SyncError("not_found", `${label(item)} is not there`);
            }
            throw failed(label(item), e);
          }
        },
        async delete(ref) {
          checkRef(ref);
          try {
            await gitlab.variables.delete(of, ref);
          } catch (e) {
            if (e instanceof GitlabError && e.kind === "not_found") {
              throw new SyncError("not_found", `${label(ref)} is not there`);
            }
            throw failed(label(ref), e);
          }
        },
      };
    },
  };
}
