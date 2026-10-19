export type RotationErrorKind =
  /** The config is not one this provider can use. */
  | "invalid_config"
  /** What `revoke` was asked to revoke is not there (already revoked or never minted). */
  | "not_found"
  /** The provider's own credential cannot do this; a person has to fix the connection. */
  | "denied"
  /** The provider failed or could not be reached. The outcome may be unknown. */
  | "failed";

/**
 * A failure of a provider. The message may name a provider and a setting but never a generated
 * value, a credential or the config; providers wrap what a system says before it gets here.
 */
export class RotationError extends Error {
  override readonly name = "RotationError";
  constructor(
    readonly kind: RotationErrorKind,
    message: string,
  ) {
    super(message);
  }
}
