/** One resource instance of a Terraform state: what names it, and nothing it holds. */
export interface StateResource {
  /** As Terraform writes it: `module.net.aws_vpc.main["eu"]`. */
  address: string;
  mode: "managed" | "data";
  type: string;
  name: string;
  /** The provider's source address, `registry.terraform.io/hashicorp/aws`, without an alias. */
  provider: string;
  /** The module path (`module.net`, `module.a["x"].module.b`), or null for the root module. */
  module: string | null;
  /** The `count` index or `for_each` key as text, or null. */
  indexKey: string | null;
}

/** The most instances one state is indexed for: a state with more is refused, so the index is never partial. */
export const MAX_INDEXED_RESOURCES = 100_000;
const MAX_FIELD = 1024;

export type ParsedResources =
  | { ok: true; resources: StateResource[] }
  | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** A NUL is text Postgres cannot keep in a text column: refused with the rest of what is not a name. */
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD && !v.includes("\0");
const SOURCE = /^provider\["([^"]+)"\]/;

/**
 * The identity of every resource instance in a Terraform state (version 4), for the index STATE-6 keeps. Only the
 * fields that name a resource are read (`module`, `mode`, `type`, `name`, `provider`, and each instance's
 * `index_key`): never `attributes`, `sensitive_attributes`, `private`, `dependencies` or `outputs`, so nothing the
 * index holds can be a secret from the state. (A `for_each` key is a name the configuration chose, and is kept; a
 * configuration that builds keys from secrets puts them in the address.) A state that does not have that shape,
 * names an instance twice or has more than `MAX_INDEXED_RESOURCES` is refused, and the reason names the problem,
 * never a value. A state with no `resources` has an empty index.
 */
export function parseStateResources(state: unknown): ParsedResources {
  if (!isObject(state)) return { ok: false, reason: "the state is not an object" };
  if (state.version !== 4) return { ok: false, reason: "the state is not version 4" };
  const list = state.resources ?? [];
  if (!Array.isArray(list)) return { ok: false, reason: "resources is not a list" };
  const resources: StateResource[] = [];
  const seen = new Set<string>();
  for (const [i, r] of list.entries()) {
    const at = `resources[${i}]`;
    if (!isObject(r)) return { ok: false, reason: `${at} is not an object` };
    if (r.mode !== "managed" && r.mode !== "data") {
      return { ok: false, reason: `${at}.mode is neither managed nor data` };
    }
    for (const field of ["type", "name", "provider"] as const) {
      if (!text(r[field])) return { ok: false, reason: `${at}.${field} is missing or too long` };
    }
    if (r.module !== undefined && !text(r.module)) {
      return { ok: false, reason: `${at}.module is not text or too long` };
    }
    if (!Array.isArray(r.instances)) return { ok: false, reason: `${at}.instances is not a list` };
    const { mode, type, name, provider } = r as {
      mode: "managed" | "data";
      type: string;
      name: string;
      provider: string;
    };
    const module = r.module ?? null;
    const prefix = `${module === null ? "" : `${module}.`}${mode === "data" ? "data." : ""}${type}.${name}`;
    for (const [j, instance] of r.instances.entries()) {
      if (!isObject(instance))
        return { ok: false, reason: `${at}.instances[${j}] is not an object` };
      const key = instance.index_key;
      if (key !== undefined && key !== null && typeof key !== "string" && !Number.isInteger(key)) {
        return {
          ok: false,
          reason: `${at}.instances[${j}].index_key is neither text nor a whole number`,
        };
      }
      if (typeof key === "string" && (key.length > MAX_FIELD || key.includes("\0"))) {
        return { ok: false, reason: `${at}.instances[${j}].index_key is too long or has a NUL` };
      }
      const indexKey = key === undefined || key === null ? null : String(key);
      const address = `${prefix}${typeof key === "number" ? `[${key}]` : indexKey === null ? "" : `[${JSON.stringify(indexKey)}]`}`;
      if (seen.has(address)) return { ok: false, reason: `${at} names an instance twice` };
      seen.add(address);
      if (resources.length === MAX_INDEXED_RESOURCES) {
        return { ok: false, reason: `the state has more than ${MAX_INDEXED_RESOURCES} instances` };
      }
      resources.push({
        address,
        mode,
        type,
        name,
        provider: provider.match(SOURCE)?.[1] ?? provider,
        module,
        indexKey,
      });
    }
  }
  return { ok: true, resources };
}
