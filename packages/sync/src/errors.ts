export type SyncErrorKind =
  /** The config is not one this adapter can use. */
  | "invalid_config"
  /** The item is not one the target can hold: an empty key or scope, a value it refuses. */
  | "invalid"
  /** The target cannot do it at all: a scope other than `*` without scopes, a secret without masking. */
  | "unsupported"
  | "not_found"
  /** `create` of a key and scope that are there. */
  | "exists"
  /** A secret whose value the target's masking rules cannot hide. It is never written unmasked. */
  | "unmaskable"
  /** The target failed or could not be reached. The outcome of a write may be unknown. */
  | "failed";

/**
 * A failure of an adapter. The message may name the key and scope but never a value, a credential
 * or the config; adapters wrap what a target says before it gets here.
 */
export class SyncError extends Error {
  override readonly name = "SyncError";
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
  ) {
    super(message);
  }
}
