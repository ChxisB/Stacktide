import { describe, expect, test } from "bun:test";
import { GitlabError } from "@orch/gitlab";
import sodium from "libsodium-wrappers";
import { sealForGithub } from "./sealed-box";

// FRG-19: a value is sealed to the public key of the scope it is written to (`crypto_box_seal`), the way GitHub asks.

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const open = (sealed: string, publicKey: Uint8Array, secretKey: Uint8Array) =>
  new TextDecoder().decode(
    sodium.crypto_box_seal_open(Buffer.from(sealed, "base64"), publicKey, secretKey),
  );

async function keys() {
  await sodium.ready;
  return sodium.crypto_box_keypair();
}

describe("sealing", () => {
  test.each([
    ["a word", "hunter2"],
    ["one character", "x"],
    ["text that is not ASCII, with a newline", "s3cret ✓ value\nwith a newline"],
    ["the largest value GitHub takes (48 KB)", "v".repeat(48 * 1024)],
  ])("%s opens with the secret key to the same text", async (_, value) => {
    const { publicKey, privateKey } = await keys();
    expect(open(await sealForGithub(b64(publicKey), value), publicKey, privateKey)).toBe(value);
  });

  test("the result is padded base64 of a sealed box: 48 bytes longer than the value", async () => {
    const { publicKey } = await keys();
    // 13 + 48 bytes is not a multiple of three, so the padding shows
    const sealed = await sealForGithub(b64(publicKey), "thirteen byte");
    expect(Buffer.from(sealed, "base64").length).toBe(13 + sodium.crypto_box_SEALBYTES);
    expect(sealed).toEndWith("==");
    // the bytes are random, so the alphabet is checked over many: a URL-safe one would show a `-` or `_` in one of them
    for (let i = 0; i < 30; i++) {
      expect(await sealForGithub(b64(publicKey), "thirteen byte")).toMatch(
        /^[A-Za-z0-9+/]+={0,2}$/,
      );
    }
    expect(sodium.crypto_box_SEALBYTES).toBe(48);
  });

  test("the same value sealed twice differs, and the result holds the value nowhere", async () => {
    const { publicKey } = await keys();
    const value = "a-value-that-must-not-show-7f3a91c2";
    const [a, b] = [
      await sealForGithub(b64(publicKey), value),
      await sealForGithub(b64(publicKey), value),
    ];
    expect(a).not.toBe(b);
    for (const sealed of [a, b]) {
      expect(sealed).not.toContain(value);
      expect(Buffer.from(sealed, "base64").toString("latin1")).not.toContain(value);
    }
  });

  test("another key pair cannot open it", async () => {
    const { publicKey } = await keys();
    const other = await keys();
    const sealed = await sealForGithub(b64(publicKey), "v");
    expect(() => open(sealed, other.publicKey, other.privateKey)).toThrow();
  });

  // Made by Go's golang.org/x/crypto/nacl/box (`SealAnonymous`), a second implementation of the same construction, with
  // a key pair made for this test only. It is the format GitHub's libsodium opens, read by ours.
  test("a box sealed by another implementation opens", async () => {
    await sodium.ready;
    const publicKey = Buffer.from("2UcI53HHV0LOHFmpS8/AifwmYCQTLkvYrC8vjeCsESk=", "base64");
    const secretKey = Buffer.from("nK/Kh8fnsNZJwapobrXWrbeU49nyBv2PIXV8ROaCLKU=", "base64");
    const sealed =
      "MfmMP0YxHODYn9e8iEcEDSLLUSxS1Mbx+PJOkHFtUDwUPyVt0yF1HBUciwr6AxrrpX14DwJXy7fKwz1qTeJu23WEvP2fCXFTWt/UWtMg7Q==";
    expect(open(sealed, publicKey, secretKey)).toBe("s3cret ✓ value\nwith a newline");
  });
});

describe("a key that is not GitHub's", () => {
  const good = Buffer.alloc(32, 7).toString("base64");
  test("a 32-byte key in padded base64 is taken", async () => {
    expect(await sealForGithub(good, "v")).toBeTruthy();
  });

  test.each([
    ["empty", ""],
    ["not base64", "not base64 at all!"],
    ["31 bytes", Buffer.alloc(31, 7).toString("base64")],
    ["33 bytes", Buffer.alloc(33, 7).toString("base64")],
    ["without its padding", good.replace(/=+$/, "")],
    ["in the URL-safe alphabet", Buffer.alloc(32, 0xfb).toString("base64url")],
  ])("%s is refused, and the value is not in the error", async (_, key) => {
    const value = "a-value-that-must-not-show-7f3a91c2";
    let error: unknown;
    try {
      await sealForGithub(key, value);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GitlabError);
    expect((error as GitlabError).kind).toBe("unexpected");
    expect((error as GitlabError).message).not.toContain(value);
  });
});
