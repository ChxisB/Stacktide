import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption (ADR-0007). A project's data key (DEK) encrypts its values with AES-256-GCM;
 * a `KeyProvider` wraps the DEK under a master key. Master-key rotation rewraps DEKs and never
 * touches the values.
 *
 * Nonces are random 96-bit values. That is safe for the ~2^32 encryptions NIST allows per key; a
 * DEK is per project, so this is far out of reach, but a DEK that is ever used more than that must
 * be replaced (a re-encrypt job, not built).
 *
 * Errors carry a code and a fixed message: never a key, a plaintext or an AAD. JavaScript cannot
 * wipe memory, so key bytes live until garbage-collected.
 */

export type CryptoErrorCode =
  | "decrypt_failed"
  | "bad_format"
  | "unknown_key"
  | "bad_config"
  | "invalid_input";

export class CryptoError extends Error {
  override readonly name = "CryptoError";
  constructor(
    readonly code: CryptoErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 1;

/** A data key. Opaque on purpose: it prints as `Dek {}` and has no enumerable state. */
export class Dek {
  declare private readonly brand: never; // type-only: no other object type-checks as a key
}
const keyBytes = new WeakMap<Dek, Uint8Array>();

function dekOf(bytes: Uint8Array): Dek {
  if (bytes.length !== KEY_BYTES)
    throw new CryptoError("bad_format", "data key has the wrong size");
  const d = new Dek();
  keyBytes.set(d, Uint8Array.from(bytes)); // a copy: the provider may reuse its buffer
  return d;
}

function bytesOf(d: Dek): Uint8Array {
  const b = keyBytes.get(d);
  if (!b) throw new CryptoError("bad_format", "not a data key");
  return b;
}

declare const aadBrand: unique symbol;
/** Context a ciphertext is bound to. Only `aad()` makes one, so callers cannot hand-roll an ambiguous string. */
export type Aad = string & { readonly [aadBrand]: true };

/**
 * Unambiguous AAD from parts: "ab"+"c" and "a"+"bc" differ, and lone surrogates (which UTF-8
 * would silently merge) are escaped. Lead with the kind of record (`aad("variable", project, id)`)
 * so ciphertexts of different kinds cannot be swapped.
 */
export const aad = (...parts: string[]) => JSON.stringify(parts) as Aad;

export const generateDek = (): Dek => dekOf(randomBytes(KEY_BYTES));

function checkKey(key: Uint8Array) {
  if (key.length !== KEY_BYTES)
    throw new CryptoError("bad_config", "master key has the wrong size");
}

/** Seals `plain` under a 32-byte key: `[version][nonce][ciphertext][tag]`. */
export function seal(key: Uint8Array, plain: Uint8Array, aadText: string): Uint8Array {
  checkKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const c = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  c.setAAD(Buffer.from(aadText));
  return Buffer.concat([Buffer.of(VERSION), nonce, c.update(plain), c.final(), c.getAuthTag()]);
}

/** Opens what `seal` made; any wrong key, AAD or altered byte is the same `decrypt_failed`. */
export function open(key: Uint8Array, blob: Uint8Array, aadText: string): Uint8Array {
  checkKey(key);
  if (
    !(blob instanceof Uint8Array) ||
    blob.length < 1 + NONCE_BYTES + TAG_BYTES ||
    blob[0] !== VERSION
  ) {
    throw new CryptoError("bad_format", "ciphertext has an unknown format");
  }
  const nonce = blob.subarray(1, 1 + NONCE_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const body = blob.subarray(1 + NONCE_BYTES, blob.length - TAG_BYTES);
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    d.setAAD(Buffer.from(aadText));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(body), d.final()]);
  } catch {
    throw new CryptoError("decrypt_failed", "decryption failed");
  }
}

/** `aad` binds the value to where it lives (e.g. project and variable id). */
export function encrypt(dek: Dek, value: string, aadText: Aad): Uint8Array {
  // UTF-8 would turn a lone surrogate into U+FFFD, and the value would not come back as it went in.
  if (!value.isWellFormed())
    throw new CryptoError("invalid_input", "value is not well-formed text");
  return seal(bytesOf(dek), Buffer.from(value, "utf8"), aadText);
}

export const decrypt = (dek: Dek, blob: Uint8Array, aadText: Aad): string =>
  Buffer.from(open(bytesOf(dek), blob, aadText)).toString("utf8");

/** A DEK sealed under a master key. Store both fields; `keyId` says which master key to ask for. */
export interface WrappedDek {
  keyId: string;
  wrapped: Uint8Array;
}

/**
 * Where master keys live. Implementations bind `aad` (and their own key id) into the wrap, so the
 * env provider and a later KMS provider are interchangeable.
 */
export interface KeyProvider {
  /** The key new wraps use; rows with another id are due for `rewrapDek`. */
  readonly currentKeyId: string;
  wrap(plain: Uint8Array, aad: Aad): Promise<WrappedDek>;
  unwrap(w: WrappedDek, aad: Aad): Promise<Uint8Array>;
}

/** `context` names the owner of the DEK (e.g. the project id); a wrap only opens for the same one. */
const dekAad = (context: string) => aad("orch:dek", context);

export async function wrapDek(p: KeyProvider, dek: Dek, context: string): Promise<WrappedDek> {
  return p.wrap(bytesOf(dek), dekAad(context));
}

export async function unwrapDek(p: KeyProvider, w: WrappedDek, context: string): Promise<Dek> {
  return dekOf(await p.unwrap(w, dekAad(context)));
}

/**
 * Moves a wrapped DEK to the provider's current master key; the values it protects stay as they
 * are. A wrap already on the current key is returned as it is (not opened, so not checked either).
 */
export async function rewrapDek(
  p: KeyProvider,
  w: WrappedDek,
  context: string,
): Promise<WrappedDek> {
  if (w.keyId === p.currentKeyId) return w;
  return wrapDek(p, await unwrapDek(p, w, context), context);
}
