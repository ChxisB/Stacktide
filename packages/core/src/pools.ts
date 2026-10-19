/** A pool's name is what `stack.yml` calls it: lower-case words joined by single dashes. */
export const POOL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_POOL_NAME = 63;
/** A runner tag as it is written into a generated job: no space, comma or `$`, so it cannot be a variable or a second tag. */
export const POOL_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_POOL_TAGS = 10;
/**
 * An image reference: a name, an optional tag, and an optional `@sha256:` digest. An `@` followed by
 * anything else is refused, so `user:password@registry/image` cannot be kept (the audit trail would hold it).
 */
export const POOL_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:-]{0,254}(@sha256:[0-9a-f]{64})?$/;
/** Pools an organization may have: every pipeline generation reads all of them. */
export const MAX_POOLS = 50;
