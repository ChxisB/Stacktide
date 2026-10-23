/** The scope of an item in a target without scopes, and of one meant for every scope of a target with. */
export const ALL_SCOPES = "*";

export interface Capabilities {
  /** `read` returns values. A target that hides them (a GitLab hidden variable) gives `null`. */
  canReadValues: boolean;
  /** The target can hide a value in logs and displays. A secret is never written to one that cannot. */
  supportsMasking: boolean;
  /** The target keeps one item per key and scope. Without, the only scope is {@link ALL_SCOPES}. */
  supportsScopes: boolean;
  /** The target can hand a value to a job as a file (a GitLab file variable). */
  supportsFiles: boolean;
}

/** What names an item: a key is its own item in each scope, and a scope never falls back to `*`. */
export interface ItemRef {
  key: string;
  scope: string;
}

export interface ItemInput extends ItemRef {
  value: string;
  /** Hide the value where the target can. The target decides how; it never un-hides a secret. */
  secret: boolean;
  /** Give the value to a job as a file, not as text. Refused as `unsupported` where the target cannot. */
  file: boolean;
}

export interface RemoteItem extends ItemRef {
  /** `null` when the target cannot return values. */
  value: string | null;
  secret: boolean;
  file: boolean;
  /**
   * When the target last changed the item, as the target words it, for a target that hides values but says when
   * (a GitHub secret). Only compared for equality, so a hand edit shows without the value.
   */
  changedAt?: string;
}

/**
 * One target, as the sync engine sees it. Every call is one request's worth of work, no more. A call
 * that can never work on this target (`invalid`, `unsupported`, `unmaskable`) fails as that before
 * the target is asked whether the item is there, so `not_found` and `exists` always mean the item.
 */
export interface Remote {
  /** Every item of every scope, ordered by key and then scope (UTF-16 code units, not locale). */
  read(): Promise<RemoteItem[]>;
  /** `exists` if the key is already there in that scope. */
  create(item: ItemInput): Promise<void>;
  /** Replaces value and secret flag. `not_found` if there is nothing in exactly that scope. */
  update(item: ItemInput): Promise<void>;
  /** `not_found` if there is nothing in exactly that scope; the engine may treat that as done. */
  delete(ref: ItemRef): Promise<void>;
}

/** A kind of target (GitLab variables, a file, ...). Every one passes `runAdapterConformance`. */
export interface SyncAdapter<Config = unknown> {
  readonly type: string;
  readonly capabilities: Capabilities;
  /**
   * Throws what a write of this item would throw because the item can never be held by this kind of
   * target (`invalid`, `unsupported`, `unmaskable`), without touching the target. Whoever builds a plan
   * calls it for every wanted item first, so the plan fails before an apply does (the plan itself
   * does not know the target); `create`/`update` fail the same way.
   */
  check(item: ItemInput): void;
  /** Checks a config object without touching the target; `invalid_config` otherwise. */
  validate(config: unknown): Config;
  /** Nothing is read or written until the {@link Remote} is used. */
  connect(config: Config): Remote;
}
