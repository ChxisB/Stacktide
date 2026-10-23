import { GitlabError } from "@orch/gitlab";
import sodium from "libsodium-wrappers";

/**
 * Seals a secret's value to the public key of the scope it is written to (`crypto_box_seal`), as GitHub asks: the
 * key is the base64 `key` that `GET …/actions/secrets/public-key` answers, and the result is the base64
 * `encrypted_value` to send with that key's `key_id`. Only GitHub can open it; this side keeps no key to do so.
 *
 * The key must be 32 bytes in padded standard base64. Anything else is refused before the value is touched, with a
 * message that holds neither the key nor the value.
 */
export async function sealForGithub(publicKey: string, value: string): Promise<string> {
  await sodium.ready;
  let key: Uint8Array;
  try {
    key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  } catch {
    key = new Uint8Array();
  }
  if (key.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new GitlabError("unexpected", "GitHub sent a public key that is not 32 bytes of base64");
  }
  return sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(value), key),
    sodium.base64_variants.ORIGINAL,
  );
}
