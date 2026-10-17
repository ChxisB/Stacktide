import { SyncError } from "./errors";
import { byKeyThenScope, refId as idOf } from "./ref";
import type { SyncAdapter } from "./types";
import { ALL_SCOPES, type Capabilities, type ItemInput, type ItemRef, type Remote } from "./types";

export interface FakeConfig {
  /** Which in-memory target: two names are two targets. */
  store: string;
}

/**
 * An adapter over memory, for tests of the engine and as the reference the conformance suite is
 * proven against. `caps` makes it behave like a target that hides values, has no scopes or cannot
 * mask. `stores` is the targets themselves, so a test can change one "by hand".
 */
export function fakeAdapter(caps: Partial<Capabilities> = {}) {
  const capabilities: Capabilities = {
    canReadValues: true,
    supportsMasking: true,
    supportsScopes: true,
    supportsFiles: true,
    ...caps,
  };
  const stores = new Map<string, Map<string, ItemInput>>();

  const checkRef = (ref: ItemRef) => {
    if (!ref.key) throw new SyncError("invalid", "the key is empty");
    if (!ref.scope) throw new SyncError("invalid", `${ref.key}: the scope is empty`);
    if (!capabilities.supportsScopes && ref.scope !== ALL_SCOPES) {
      throw new SyncError("unsupported", `${ref.key}: this target has no scopes`);
    }
  };
  const check = (item: ItemInput) => {
    checkRef(item);
    if (item.secret && !capabilities.supportsMasking) {
      throw new SyncError("unsupported", `${item.key}: this target cannot mask a value`);
    }
    if (item.file && !capabilities.supportsFiles) {
      throw new SyncError("unsupported", `${item.key}: this target has no file values`);
    }
  };

  const adapter: SyncAdapter<FakeConfig> = {
    type: "fake",
    capabilities,
    check,
    validate(config) {
      const store = (config as { store?: unknown } | null)?.store;
      if (typeof store !== "string" || !store) {
        throw new SyncError("invalid_config", "the config is { store: <name> }");
      }
      return { store };
    },
    connect({ store }): Remote {
      const items = stores.get(store) ?? new Map<string, ItemInput>();
      stores.set(store, items);
      return {
        async read() {
          return [...items.values()].sort(byKeyThenScope).map((i) => ({
            key: i.key,
            scope: i.scope,
            value: capabilities.canReadValues ? i.value : null,
            secret: i.secret,
            file: i.file,
          }));
        },
        async create(item) {
          check(item);
          if (items.has(idOf(item))) {
            throw new SyncError("exists", `${item.key} (${item.scope}) is already there`);
          }
          items.set(idOf(item), { ...item });
        },
        async update(item) {
          check(item);
          if (!items.has(idOf(item))) {
            throw new SyncError("not_found", `${item.key} (${item.scope}) is not there`);
          }
          items.set(idOf(item), { ...item });
        },
        async delete(ref) {
          checkRef(ref);
          if (!items.delete(idOf(ref))) {
            throw new SyncError("not_found", `${ref.key} (${ref.scope}) is not there`);
          }
        },
      };
    },
  };
  return { adapter, stores };
}
