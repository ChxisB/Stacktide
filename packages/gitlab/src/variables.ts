import { z } from "zod";
import type { GitlabClient } from "./client";
import { decode } from "./decode";
import { GitlabError } from "./errors";
import { type ProjectRef, projectPath } from "./projects";

/** Whose variables: a project's, or a group's (group `scope` needs Premium on GitLab). */
export type VariableOwner = { project: ProjectRef } | { group: number | string };

/** A variable is identified by key and environment scope; the scope defaults to `*`. */
export interface VariableRef {
  key: string;
  scope?: string;
}

export interface VariableInput {
  /** A secret: sent to GitLab, never logged, scrubbed from errors (values under 4 characters excepted). */
  value: string;
  type?: "env_var" | "file";
  protected?: boolean;
  masked?: boolean;
  /**
   * True: `$` in the value is not expanded. Create sends true unless told otherwise, whatever
   * GitLab's own default is; update leaves it as it is. It changes what can be masked.
   */
  raw?: boolean;
  /** The scope to move the variable to (update) or create it in. */
  scope?: string;
  description?: string | null;
}

export interface CreateVariableInput extends VariableInput {
  /** Masked and hidden: the value can never be read back. Create-only, GitLab 17.4+. */
  hidden?: boolean;
}

const ALL = "*";
const KEY = /^[A-Za-z0-9_]{1,255}$/;

/**
 * GitLab's masking rules for a value (docs.gitlab.com/ci/variables): one line without spaces,
 * 8+ characters, and, when `$` references are expanded (`raw: false`), only letters, digits and
 * `_ : @ - + . ~ = /`. It cannot see the other rule, that a value must not equal the name of an
 * existing variable. `raw` defaults to true, as in `create`.
 */
export function canMask(value: string, o: { raw?: boolean } = {}): boolean {
  if (!/^\S{8,}$/.test(value)) return false;
  return o.raw === false ? /^[\w:@+.~=/-]+$/.test(value) : true;
}

/**
 * A variable as GitLab holds it. The value sits behind a getter over a private field, so
 * JSON.stringify, spread, Object.keys and console.log (`value: [Getter]`) never show it: a variable
 * handed to a logger or serialised into a response cannot leak its value by accident.
 */
export class CiVariable {
  readonly key: string;
  readonly type: "env_var" | "file";
  readonly protected: boolean;
  readonly masked: boolean;
  /** Masked and hidden: the value is not readable. */
  readonly hidden: boolean;
  readonly raw: boolean;
  readonly scope: string;
  readonly description: string | null;
  readonly #value: string | null;

  constructor(f: Omit<CiVariable, "value">, value: string | null) {
    this.key = f.key;
    this.type = f.type;
    this.protected = f.protected;
    this.masked = f.masked;
    this.hidden = f.hidden;
    this.raw = f.raw;
    this.scope = f.scope;
    this.description = f.description;
    this.#value = value;
  }

  /** Null when the target does not show it. */
  get value(): string | null {
    return this.#value;
  }
}

const variable = z
  .object({
    key: z.string(),
    // Null when the target hides it (`hidden`).
    value: z.string().nullish(),
    variable_type: z.enum(["env_var", "file"]),
    protected: z.boolean(),
    masked: z.boolean(),
    hidden: z.boolean().optional(),
    // Absent before GitLab 15.2, where every variable was expanded.
    raw: z.boolean().optional(),
    // Absent for group variables on the Free tier.
    environment_scope: z.string().optional(),
    description: z.string().nullish(),
  })
  .transform(
    (v) =>
      new CiVariable(
        {
          key: v.key,
          type: v.variable_type,
          protected: v.protected,
          masked: v.masked,
          hidden: v.hidden ?? false,
          raw: v.raw ?? false,
          scope: v.environment_scope ?? ALL,
          description: v.description ?? null,
        },
        v.value ?? null,
      ),
  );

function assertKey(key: string) {
  if (!KEY.test(key)) {
    throw new TypeError("GitLab variable key must be 1-255 letters, digits or _");
  }
}

export function variablesApi(client: GitlabClient) {
  const base = (o: VariableOwner) =>
    "project" in o
      ? `${projectPath(o.project)}/variables`
      : `/groups/${encodeURIComponent(String(o.group))}/variables`;
  const filter = (scope: string) => ({ "filter[environment_scope]": scope });
  const fields = (i: VariableInput) => ({
    value: i.value,
    variable_type: i.type,
    protected: i.protected,
    masked: i.masked,
    raw: i.raw,
    environment_scope: i.scope,
    description: i.description,
  });

  /** Group scopes are Premium: a Free group may ignore one and keep `*`, which must not go unnoticed. */
  function applied(v: CiVariable, scope: string | undefined) {
    if (scope !== undefined && v.scope !== scope) {
      throw new GitlabError("unexpected", `GitLab did not apply scope ${scope} to ${v.key}`);
    }
    return v;
  }

  /**
   * The variable with exactly this key and scope. GitLab may answer a filter that matches nothing
   * with a same-named variable of another scope, and its update falls back the same way, so every
   * write goes through here first and never touches a variable it was not pointed at.
   * (Another writer can still change things between this read and the write.)
   */
  async function get(owner: VariableOwner, ref: VariableRef) {
    assertKey(ref.key);
    const scope = ref.scope ?? ALL;
    const raw = await client.request("GET", `${base(owner)}/${ref.key}`, { query: filter(scope) });
    const found = decode(variable, raw, "variable");
    if (found.scope !== scope) {
      throw new GitlabError("not_found", `GitLab variable ${ref.key} has no scope ${scope}`);
    }
    return found;
  }

  return {
    variables: {
      /** Every variable of the owner, all scopes. Values come back only when the target shows them. */
      async *list(owner: VariableOwner) {
        for await (const raw of client.paginate(base(owner)))
          yield decode(variable, raw, "variable");
      },
      get,
      /** A key already used in the same scope is `invalid`. */
      async create(owner: VariableOwner, key: string, input: CreateVariableInput) {
        assertKey(key);
        const raw = await client.request("POST", base(owner), {
          body: {
            key,
            ...fields(input),
            raw: input.raw ?? true,
            masked_and_hidden: input.hidden,
          },
          redact: [input.value],
        });
        return applied(decode(variable, raw, "variable"), input.scope);
      },
      /**
       * Sets the given fields of the variable at `ref` (`value` always), leaving the others as
       * they are; `input.scope` moves it to another scope.
       */
      async update(owner: VariableOwner, ref: VariableRef, input: VariableInput) {
        await get(owner, ref);
        const raw = await client.request("PUT", `${base(owner)}/${ref.key}`, {
          query: filter(ref.scope ?? ALL),
          body: fields(input),
          redact: [input.value],
        });
        return applied(decode(variable, raw, "variable"), input.scope ?? ref.scope);
      },
      /** `not_found` when it is already gone; callers decide whether that matters. */
      async delete(owner: VariableOwner, ref: VariableRef) {
        await get(owner, ref);
        await client.request("DELETE", `${base(owner)}/${ref.key}`, {
          query: filter(ref.scope ?? ALL),
        });
      },
    },
  };
}
