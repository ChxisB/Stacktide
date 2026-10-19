/** Whose rotation it is: a provider that reaches into the platform (a stored connection) must stay inside this organization. */
export interface Scope {
  organizationId: string;
}

/** What a provider is asked to rotate. `config` is the provider's own, never a secret. */
export interface RotateContext<Config> extends Scope {
  config: Config;
  /** The variable's key, for naming what the provider mints. Never its value. */
  key: string;
}

export interface Minted<Config> {
  /** The new credential. Written as a variable version and nowhere else. */
  value: string;
  /**
   * Names what was minted so `revoke` can undo it: an id, never a credential, kept in the open.
   * `null` for a provider with nothing to revoke (a random string lives nowhere else).
   */
  handle: string | null;
  /** The config for the next rotation when the old one no longer fits (a token id that changed). */
  config?: Config;
}

/**
 * A kind of secret that can be replaced with a fresh one (random, a GitLab token, ...). Every one
 * passes `runRotatorConformance`. A rotator holds no state: the platform stores the config and the
 * handle, and calls `rotate` when a rotation is due.
 */
export interface Rotator<Config = unknown> {
  readonly type: string;
  /**
   * True when a rotation changes something at the provider: it mints a credential there (so `rotate`
   * returns a `handle`) and may end the old one. False when the value lives only as a variable
   * version. A protected environment holds a new value until a person approves it, which only a
   * provider that is not `external` can wait for: the old credential stays valid and no new one is
   * stranded if the request is rejected.
   */
  readonly external: boolean;
  /**
   * True when minting ends the credential it replaces, at the provider and in the same step (GitLab's
   * token rotation does): there is nothing to keep for a grace period and nothing to revoke later,
   * so a rotation records no replaced handle and a setting with `graceDays` above 0 is refused.
   */
  readonly endsReplaced?: boolean;
  /** Checks a config object without touching anything; `invalid_config` otherwise. */
  validate(config: unknown): Config;
  /**
   * How long a new credential lives at the provider, in days, when it ends on its own: a rotation
   * interval has to be shorter, or the variable would hold a dead value while it waits for its turn.
   */
  lifetimeDays?(config: Config): number;
  rotate(ctx: RotateContext<Config>): Promise<Minted<Config>>;
  /** Idempotent: a handle that is already revoked or unknown is done, not an error. */
  revoke(config: Config, handle: string, scope: Scope): Promise<void>;
}

/** Where a lease is made: ids only, never a credential. */
export interface LeaseTarget {
  connectionId: string;
  /** The provider's own id for the project (GitLab's numeric id). */
  projectId: number;
}

export interface LeaseRequest extends Scope {
  target: LeaseTarget;
  scopes: readonly string[];
  /** When the platform ends it. The provider's own expiry is never earlier, and at most a day later. */
  expiresAt: Date;
  /** Names the credential at the provider, so a person can tell what it is for. Never secret. */
  name: string;
}

/**
 * A kind of credential that can be made for a short while (ADR-0014). Unlike a `Rotator` it replaces
 * nothing: every issue makes a new credential, and the platform revokes it at expiry or on request.
 */
export interface Leaser {
  readonly type: string;
  /** `value` is shown once to whoever asked and stored nowhere; `handle` names it for `revoke`. */
  issue(request: LeaseRequest): Promise<{ value: string; handle: string }>;
  /** Idempotent: a handle that is already revoked or unknown is done, not an error. */
  revoke(target: LeaseTarget, handle: string, scope: Scope): Promise<void>;
}
