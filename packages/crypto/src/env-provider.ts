import { type Aad, CryptoError, type KeyProvider, open, seal, type WrappedDek } from "./crypto";

const ID = /^[A-Za-z0-9_.-]{1,32}$/;
const KEY_B64 = /^[A-Za-z0-9+/]{43}=$/; // 32 bytes

const bad = (why: string) => new CryptoError("bad_config", `ORCH_MASTER_KEYS: ${why}`);

/**
 * Master keys from the environment: `ORCH_MASTER_KEYS="k2:<base64>,k1:<base64>"`, each key 32 random
 * bytes (`openssl rand -base64 32`). The first entry wraps new DEKs; the rest only unwrap, so
 * rotating is adding a new first entry, running the rewrap, then dropping the old one. For local
 * and early use only (ADR-0007): anyone who can read the process environment can read the keys.
 * Errors name the entry's position, never its text.
 */
export function envKeyProvider(raw: string | undefined): KeyProvider {
  if (!raw?.trim()) throw bad("is not set");
  const keys = new Map<string, Buffer>();
  raw.split(",").forEach((entry, i) => {
    const at = entry.indexOf(":");
    const id = entry.slice(0, at).trim();
    const b64 = entry.slice(at + 1).trim();
    if (at < 0 || !ID.test(id)) throw bad(`entry ${i + 1} needs an id like "k1" before the colon`);
    if (!KEY_B64.test(b64)) throw bad(`entry ${i + 1} must be base64 of 32 bytes`);
    if (keys.has(id)) throw bad(`entry ${i + 1} repeats an id`);
    const key = Buffer.from(b64, "base64");
    // Stray bits in the last character would let two different strings be the same key.
    if (key.toString("base64") !== b64) throw bad(`entry ${i + 1} must be base64 of 32 bytes`);
    keys.set(id, key);
  });
  const currentKeyId = keys.keys().next().value as string;

  const keyFor = (id: string) => {
    const k = keys.get(id);
    if (!k)
      throw new CryptoError("unknown_key", "no master key with the id the data was wrapped with");
    return k;
  };
  // The key id is part of the AAD, so moving a wrap to a row with another id cannot succeed.
  const bind = (id: string, aad: Aad) => JSON.stringify([id, aad]);

  return {
    currentKeyId,
    async wrap(plain, aad): Promise<WrappedDek> {
      return {
        keyId: currentKeyId,
        wrapped: seal(keyFor(currentKeyId), plain, bind(currentKeyId, aad)),
      };
    },
    async unwrap(w, aad) {
      return open(keyFor(w.keyId), w.wrapped, bind(w.keyId, aad));
    },
  };
}
