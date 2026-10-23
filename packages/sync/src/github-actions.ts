import type { ActionsApi, ActionsScope, ActionsVisibility } from "@orch/github";
import { GitlabError } from "@orch/gitlab";
import { z } from "zod";
import { SyncError } from "./errors";
import { byKeyThenScope, label } from "./ref";
import {
  ALL_SCOPES,
  type Capabilities,
  type ItemInput,
  type ItemRef,
  type Remote,
  type RemoteItem,
  type SyncAdapter,
} from "./types";

export const GITHUB_ACTIONS = "github-actions";

/** GitHub takes at most 48 KB of a secret or a variable. */
const MAX_BYTES = 48 * 1024;

// The words of GitHub's own rule, in capitals because GitHub stores a name in capitals: a lower-case key would read
// back as another and be created again on every plan.
const NAME = /^[A-Z_][A-Z0-9_]*$/;

// Kept here, not imported, so a config is checked without a client; the client checks again before a request.
const part = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine((s) => s !== "." && s !== "..");
const repository = z.string().refine((s) => {
  const parts = s.split("/");
  return parts.length === 2 && parts.every((p) => part.safeParse(p).success);
});
const environment = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !s.includes("/") && s !== "." && s !== "..");
const flag = z.boolean().optional();

const configSchema = z.union([
  z.strictObject({ repository, protected: flag }),
  z.strictObject({ repository, environment, protected: flag }),
  z.strictObject({
    organization: part,
    visibility: z.enum(["all", "private"]).optional(),
    protected: flag,
  }),
]);

/**
 * Whose Actions secrets and variables: a repository's, one of its environments', or an organization's, which also says
 * which repositories see them (`private` when left out, never `selected`). The credential is not here: it belongs to the
 * connection the client was made from.
 */
export type GithubActionsConfig = z.infer<typeof configSchema>;

/** The config as stored: checked, and stripped of anything not in the shape. The error repeats nothing of what was given. */
export function parseGithubActionsConfig(config: unknown): GithubActionsConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new SyncError(
      "invalid_config",
      "the config is { repository: owner/name }, { repository, environment } or { organization, visibility? }, and optionally { protected }",
    );
  }
  return parsed.data;
}

/** Fixed words, so nothing GitHub said, no value and no URL can reach an error. */
function failed(what: string, e: unknown) {
  const why =
    e instanceof GitlabError ? `GitHub answered ${e.kind}` : "the request could not be made";
  return new SyncError("failed", `${what}: ${why}`);
}

const gone = (e: unknown) => e instanceof GitlabError && e.kind === "not_found";

/**
 * GitHub Actions secrets and variables of one repository, environment or organization as a sync target (FRG-20).
 *
 * An item is a secret when the platform says so and a variable otherwise; a name is one item whichever it is. A secret
 * is sealed to the scope's key and can never be read: `read` gives it with no value and with the time GitHub says it
 * changed, so a plan can tell an edit nobody applied. A variable is read as it is. There are no scopes and no files.
 * `api` is the client of one connection.
 * shortcut: a write asks whether the name is held in each kind first (two requests); fold it into the list read when an
 * apply writes many.
 */
export function githubActionsAdapter(api: ActionsApi): SyncAdapter<GithubActionsConfig> {
  const capabilities: Capabilities = {
    // a variable's value is read; a secret's is `null` on its own item
    canReadValues: true,
    supportsMasking: true,
    supportsScopes: false,
    supportsFiles: false,
  };

  const checkRef = (ref: ItemRef) => {
    if (!NAME.test(ref.key) || ref.key.startsWith("GITHUB_")) {
      throw new SyncError(
        "invalid",
        `${JSON.stringify(ref.key.slice(0, 64))}: a GitHub Actions name is capital letters, digits and _, does not start with a digit and does not start with GITHUB_`,
      );
    }
    if (!ref.scope) throw new SyncError("invalid", `${label(ref)}: the scope is empty`);
    if (ref.scope !== ALL_SCOPES) {
      throw new SyncError(
        "unsupported",
        `${label(ref)}: GitHub Actions has no scopes, only ${ALL_SCOPES}`,
      );
    }
  };
  const check = (item: ItemInput) => {
    checkRef(item);
    if (item.file) {
      throw new SyncError("unsupported", `${label(item)}: GitHub Actions cannot hold a file`);
    }
    if (Buffer.byteLength(item.value) > MAX_BYTES) {
      throw new SyncError("invalid", `${label(item)}: GitHub takes at most 48 KB`);
    }
  };

  return {
    type: GITHUB_ACTIONS,
    capabilities,
    check,
    validate: parseGithubActionsConfig,
    connect(config): Remote {
      const scope: ActionsScope =
        "organization" in config
          ? { organization: config.organization }
          : "environment" in config
            ? { repository: config.repository, environment: config.environment }
            : { repository: config.repository };
      const visibility: ActionsVisibility | undefined =
        "visibility" in config ? config.visibility : undefined;

      /** Whether a name is held as a secret and as a variable. */
      const held = async (ref: ItemRef) => {
        try {
          return {
            secret: await api.secrets.has(scope, ref.key),
            variable: await api.variables.has(scope, ref.key),
          };
        } catch (e) {
          throw failed(label(ref), e);
        }
      };
      const dropVariable = (ref: ItemRef) => api.variables.delete(scope, ref.key);
      const dropSecret = (ref: ItemRef) => api.secrets.delete(scope, ref.key);

      return {
        async read() {
          const items: RemoteItem[] = [];
          try {
            const secrets = await api.secrets.list(scope);
            for (const s of secrets) {
              items.push({
                key: s.name,
                scope: ALL_SCOPES,
                value: null,
                secret: true,
                file: false,
                changedAt: s.updatedAt,
              });
            }
            const named = new Set(secrets.map((s) => s.name));
            // a name held both ways is the secret: the planner must see one item, and the update that follows heals it
            for (const v of await api.variables.list(scope)) {
              if (named.has(v.name)) continue;
              items.push({
                key: v.name,
                scope: ALL_SCOPES,
                value: v.value,
                secret: false,
                file: false,
              });
            }
          } catch (e) {
            throw failed("reading the secrets and variables", e);
          }
          return items.sort(byKeyThenScope);
        },

        async create(item) {
          check(item);
          const now = await held(item);
          if (now.secret || now.variable) {
            throw new SyncError("exists", `${label(item)} is already there`);
          }
          try {
            if (item.secret) await api.secrets.put(scope, item.key, item.value, { visibility });
            else await api.variables.create(scope, item.key, item.value, { visibility });
          } catch (e) {
            if (e instanceof GitlabError && e.kind === "conflict") {
              throw new SyncError("exists", `${label(item)} is already there`);
            }
            throw failed(label(item), e);
          }
        },

        async update(item) {
          check(item);
          const now = await held(item);
          if (!now.secret && !now.variable) {
            throw new SyncError("not_found", `${label(item)} is not there`);
          }
          try {
            if (item.secret) {
              // the readable value goes first, so a failure after it cannot leave a secret's old value in plain sight
              if (now.variable) await dropVariable(item);
              await api.secrets.put(scope, item.key, item.value, { visibility });
            } else {
              if (now.variable)
                await api.variables.update(scope, item.key, item.value, { visibility });
              else await api.variables.create(scope, item.key, item.value, { visibility });
              // the secret goes last, so a failure before it leaves the name read as a secret, which the next plan changes
              if (now.secret) await dropSecret(item);
            }
          } catch (e) {
            throw failed(label(item), e);
          }
        },

        async delete(ref) {
          checkRef(ref);
          let removed = false;
          try {
            for (const drop of [dropSecret, dropVariable]) {
              try {
                await drop(ref);
                removed = true;
              } catch (e) {
                if (!gone(e)) throw e;
              }
            }
          } catch (e) {
            throw failed(label(ref), e);
          }
          if (!removed) throw new SyncError("not_found", `${label(ref)} is not there`);
        },
      };
    },
  };
}
