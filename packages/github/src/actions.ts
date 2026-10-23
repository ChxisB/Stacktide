import { GitlabError } from "@orch/gitlab";
import { z } from "zod";
import type { GithubClient } from "./client";
import { decode } from "./decode";
import { fullName, segment } from "./paths";
import { sealForGithub } from "./sealed-box";

/**
 * Whose Actions secrets and variables: a repository's, one of its environments', or an organization's. The names go
 * into a URL, so each is checked here and not trusted to have been checked by whoever stored it.
 */
export type ActionsScope = { repository: string; environment?: string } | { organization: string };

/** Which of an organization's repositories see an item. `selected` needs repository ids and is not offered. */
export type ActionsVisibility = "all" | "private";

export interface ActionsSecret {
  name: string;
  /** When GitHub last changed it. A secret's value is never readable, so this is all that shows a hand edit. */
  updatedAt: string;
}

export interface ActionsVariable extends ActionsSecret {
  value: string;
}

const secret = z.object({ name: z.string(), updated_at: z.string() });
const variable = secret.extend({ value: z.string() });
const publicKey = z.object({ key_id: z.string().min(1), key: z.string().min(1) });

const rootOf = (scope: ActionsScope) =>
  "organization" in scope
    ? `/orgs/${segment(scope.organization)}/actions`
    : scope.environment === undefined
      ? `/repos/${fullName(scope.repository)}/actions`
      : `/repos/${fullName(scope.repository)}/environments/${segment(scope.environment)}`;

// GitHub's own words for a name it will take: letters, digits and `_`, no leading digit, no `GITHUB_` prefix.
const nameAt = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^github_/i.test(name)) {
    throw new GitlabError("invalid", `Not a name GitHub Actions can hold: ${name.slice(0, 64)}`);
  }
  return encodeURIComponent(name);
};

const absent = (e: unknown) => e instanceof GitlabError && e.kind === "not_found";

/**
 * Actions secrets and variables (FRG-20). A secret is written sealed to the scope's public key (`sealForGithub`) and
 * can never be read back: a list gives names and `updated_at`. A variable is plain and readable. An item's own
 * request is one call; `put` also asks for the key, so a rotated key is never used.
 * shortcut: the key is read once per secret written (two requests); cache it per run when an apply writes many.
 */
export function actionsApi(client: GithubClient) {
  const list = async <T extends z.ZodType>(
    scope: ActionsScope,
    kind: "secrets" | "variables",
    schema: T,
  ): Promise<z.output<T>[]> => {
    const out: z.output<T>[] = [];
    // a variables list answers 30 at most per page, a secrets list 100
    for await (const raw of client.paginate(
      `${rootOf(scope)}/${kind}`,
      { per_page: kind === "variables" ? 30 : 100 },
      kind,
    )) {
      out.push(decode(schema, raw, kind === "secrets" ? "secret" : "variable"));
    }
    return out;
  };
  const has = async (scope: ActionsScope, kind: "secrets" | "variables", name: string) => {
    try {
      await client.request("GET", `${rootOf(scope)}/${kind}/${nameAt(name)}`);
      return true;
    } catch (e) {
      if (absent(e)) return false;
      throw e;
    }
  };
  const visibility = (scope: ActionsScope, v: ActionsVisibility | undefined) =>
    "organization" in scope ? { visibility: v ?? "private" } : {};

  return {
    secrets: {
      list: async (scope: ActionsScope): Promise<ActionsSecret[]> =>
        (await list(scope, "secrets", secret)).map((s) => ({
          name: s.name,
          updatedAt: s.updated_at,
        })),
      has: (scope: ActionsScope, name: string) => has(scope, "secrets", name),
      /** Creates or replaces. An organization's secret is for its private repositories unless `visibility` says otherwise. */
      async put(
        scope: ActionsScope,
        name: string,
        value: string,
        o: { visibility?: ActionsVisibility } = {},
      ): Promise<void> {
        const at = `${rootOf(scope)}/secrets`;
        const path = `${at}/${nameAt(name)}`;
        const key = decode(
          publicKey,
          await client.request("GET", `${at}/public-key`),
          "public key",
        );
        await client.request("PUT", path, {
          body: {
            encrypted_value: await sealForGithub(key.key, value),
            key_id: key.key_id,
            ...visibility(scope, o.visibility),
          },
          redact: [value],
        });
      },
      delete: async (scope: ActionsScope, name: string): Promise<void> => {
        await client.request("DELETE", `${rootOf(scope)}/secrets/${nameAt(name)}`);
      },
    },
    variables: {
      list: async (scope: ActionsScope): Promise<ActionsVariable[]> =>
        (await list(scope, "variables", variable)).map((v) => ({
          name: v.name,
          value: v.value,
          updatedAt: v.updated_at,
        })),
      has: (scope: ActionsScope, name: string) => has(scope, "variables", name),
      /** `conflict` when the name is taken. */
      create: async (
        scope: ActionsScope,
        name: string,
        value: string,
        o: { visibility?: ActionsVisibility } = {},
      ): Promise<void> => {
        nameAt(name);
        await client.request("POST", `${rootOf(scope)}/variables`, {
          body: { name, value, ...visibility(scope, o.visibility) },
          redact: [value],
        });
      },
      /** `not_found` when there is none. */
      update: async (
        scope: ActionsScope,
        name: string,
        value: string,
        o: { visibility?: ActionsVisibility } = {},
      ): Promise<void> => {
        await client.request("PATCH", `${rootOf(scope)}/variables/${nameAt(name)}`, {
          body: { name, value, ...visibility(scope, o.visibility) },
          redact: [value],
        });
      },
      delete: async (scope: ActionsScope, name: string): Promise<void> => {
        await client.request("DELETE", `${rootOf(scope)}/variables/${nameAt(name)}`);
      },
    },
  };
}

export type ActionsApi = ReturnType<typeof actionsApi>;
