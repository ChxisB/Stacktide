import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  aad,
  CryptoError,
  type Dek,
  decrypt,
  encrypt,
  envKeyProvider,
  generateDek,
  rewrapDek,
  unwrapDek,
  wrapDek,
} from "./index";

const b64 = () => randomBytes(32).toString("base64");
const provider = (...ids: string[]) => envKeyProvider(ids.map((i) => `${i}:${b64()}`).join(","));
const A = aad("project-1", "var-1");
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof CryptoError ? e.code : `other:${e}`;
  }
  return "no error";
};
const codeAsync = (fn: () => Promise<unknown>) =>
  fn().then(
    () => "no error",
    (e) => e.code,
  );

describe("encrypt / decrypt", () => {
  test("round-trips text, empty, unicode and large values", () => {
    const dek = generateDek();
    for (const v of ["", "hunter2", "pässwörd 🔑\n\t\"'", "x".repeat(1_000_000)]) {
      expect(decrypt(dek, encrypt(dek, v, A), A)).toBe(v);
    }
  });

  test("random values and AADs round-trip", () => {
    const dek = generateDek();
    for (let i = 0; i < 200; i++) {
      const v = randomBytes(i).toString("base64");
      const a = aad(randomBytes(4).toString("hex"), String(i));
      expect(decrypt(dek, encrypt(dek, v, a), a)).toBe(v);
    }
  });

  test("the ciphertext hides the value and differs on every call", () => {
    const dek = generateDek();
    const one = encrypt(dek, "same value", A);
    expect(Buffer.from(one).includes("same value")).toBe(false);
    expect(Buffer.from(one).equals(Buffer.from(encrypt(dek, "same value", A)))).toBe(false);
  });

  test("nonces never repeat in 10,000 encryptions", () => {
    const dek = generateDek();
    const nonces = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      nonces.add(Buffer.from(encrypt(dek, "v", A).subarray(1, 13)).toString("hex"));
    }
    expect(nonces.size).toBe(10_000);
  });

  test("any changed byte fails: version, nonce, body and tag", () => {
    const dek = generateDek();
    const blob = encrypt(dek, "a secret value", A);
    for (let i = 0; i < blob.length; i++) {
      const bad = Uint8Array.from(blob);
      bad[i] = (bad[i] ?? 0) ^ 1;
      // Byte 0 is the format version; every other byte is covered by the GCM tag.
      expect(code(() => decrypt(dek, bad, A))).toBe(i === 0 ? "bad_format" : "decrypt_failed");
    }
  });

  test("a changed AAD, another key, or a truncated blob fails", () => {
    const dek = generateDek();
    const blob = encrypt(dek, "v", A);
    expect(code(() => decrypt(dek, blob, aad("project-1", "var-2")))).toBe("decrypt_failed");
    expect(code(() => decrypt(generateDek(), blob, A))).toBe("decrypt_failed");
    expect(code(() => decrypt(dek, blob.subarray(0, 20), A))).toBe("bad_format");
    expect(code(() => decrypt(dek, new Uint8Array(), A))).toBe("bad_format");
  });

  test("opens a ciphertext built independently (fixed vector: layout and AAD encoding)", async () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i);
    const kat = {
      currentKeyId: "kat",
      wrap: async () => ({ keyId: "kat", wrapped: new Uint8Array() }),
      unwrap: async () => key,
    };
    const dek = await unwrapDek(kat, { keyId: "kat", wrapped: new Uint8Array() }, "x");
    const blob = Buffer.from(
      "01000102030405060708090a0b3431b569a091e26dec2de2ee11a1f790e4f09e9426799c51aa71621e",
      "hex",
    );
    expect(decrypt(dek, blob, aad("variable", "p1", "v1"))).toBe("s3cret value");
  });

  test("rejects a forged key, a non-binary blob, and text that does not survive UTF-8", async () => {
    const dek = generateDek();
    const blob = encrypt(dek, "v", A);
    expect(code(() => encrypt({} as Dek, "v", A))).toBe("bad_format");
    expect(code(() => decrypt(dek, Buffer.from(blob).toString("hex") as never, A))).toBe(
      "bad_format",
    );
    expect(code(() => encrypt(dek, "ok\ud800", A))).toBe("invalid_input");
    // aad() escapes a lone surrogate, so two different ones stay different.
    expect(aad("\ud800")).not.toBe(aad("\ud801"));
    const wrong = {
      currentKeyId: "x",
      wrap: async () => ({ keyId: "x", wrapped: blob }),
      unwrap: async () => new Uint8Array(16),
    };
    expect(await codeAsync(() => unwrapDek(wrong, { keyId: "x", wrapped: blob }, "c"))).toBe(
      "bad_format",
    );
  });

  test("aad parts cannot be shifted into each other", () => {
    expect(aad("ab", "c")).not.toBe(aad("a", "bc"));
    const dek = generateDek();
    expect(code(() => decrypt(dek, encrypt(dek, "v", aad("ab", "c")), aad("a", "bc")))).toBe(
      "decrypt_failed",
    );
  });
});

describe("wrapped data keys", () => {
  test("a DEK survives wrap and unwrap and still decrypts its values", async () => {
    const p = provider("k1");
    const dek = generateDek();
    const blob = encrypt(dek, "value", A);
    const w = await wrapDek(p, dek, "project-1");
    expect(w.keyId).toBe("k1");
    expect(decrypt(await unwrapDek(p, w, "project-1"), blob, A)).toBe("value");
  });

  test("fails for another owner, another master key, or a tampered wrap", async () => {
    const p = provider("k1");
    const w = await wrapDek(p, generateDek(), "project-1");
    expect(await codeAsync(() => unwrapDek(p, w, "project-2"))).toBe("decrypt_failed");
    expect(await codeAsync(() => unwrapDek(provider("k1"), w, "project-1"))).toBe("decrypt_failed");
    const wrapped = Uint8Array.from(w.wrapped);
    wrapped[20] = (wrapped[20] ?? 0) ^ 1;
    expect(await codeAsync(() => unwrapDek(p, { ...w, wrapped }, "project-1"))).toBe(
      "decrypt_failed",
    );
  });

  test("a wrap cannot be passed off under another key id", async () => {
    // Same raw key under two ids: only the id binding stops the swap.
    const key = b64();
    const p = envKeyProvider(`k2:${key},k1:${key}`);
    const w = await wrapDek(envKeyProvider(`k1:${key}`), generateDek(), "project-1");
    expect(await codeAsync(() => unwrapDek(p, { ...w, keyId: "k2" }, "project-1"))).toBe(
      "decrypt_failed",
    );
    expect(await codeAsync(() => unwrapDek(p, { ...w, keyId: "k9" }, "project-1"))).toBe(
      "unknown_key",
    );
  });

  test("a short or empty wrap is a format error, not a crash", async () => {
    const p = provider("k1");
    for (const wrapped of [new Uint8Array(), new Uint8Array(10), randomBytes(500)]) {
      expect(await codeAsync(() => unwrapDek(p, { keyId: "k1", wrapped }, "c"))).toMatch(
        /bad_format|decrypt_failed/,
      );
    }
  });

  test("rewrap leaves a wrap already on the current key alone", async () => {
    const p = provider("k1");
    const w = await wrapDek(p, generateDek(), "project-1");
    expect(await rewrapDek(p, w, "project-1")).toBe(w);
  });

  test("rotation: rewrap moves the DEK to the new master key without touching values", async () => {
    const k1 = b64();
    const k2 = b64();
    const before = envKeyProvider(`k1:${k1}`);
    const rotating = envKeyProvider(`k2:${k2},k1:${k1}`);
    const after = envKeyProvider(`k2:${k2}`);

    const dek = generateDek();
    const blob = encrypt(dek, "value", A);
    const old = await wrapDek(before, dek, "project-1");

    const moved = await rewrapDek(rotating, old, "project-1");
    expect(moved.keyId).toBe("k2");
    expect(Buffer.from(moved.wrapped).equals(Buffer.from(old.wrapped))).toBe(false);
    expect(decrypt(await unwrapDek(after, moved, "project-1"), blob, A)).toBe("value");
    // Once k1 is dropped, an un-rewrapped DEK is reported, not guessed at.
    expect(await codeAsync(() => unwrapDek(after, old, "project-1"))).toBe("unknown_key");
  });
});

describe("envKeyProvider", () => {
  test("the first key is current", () => {
    expect(envKeyProvider(`b:${b64()},a:${b64()}`).currentKeyId).toBe("b");
  });

  test("rejects bad configuration without echoing it", () => {
    const canary = "CANARY-not-a-key-0123456789";
    const good = b64();
    for (const raw of [
      undefined,
      "",
      "  ",
      good, // no id
      `:${good}`,
      `k1:${canary}`,
      `k1:${randomBytes(16).toString("base64")}`,
      `k1:${good},k1:${b64()}`,
      `k1:${good},`,
      `bad id:${good}`,
      `${"x".repeat(33)}:${good}`,
      `k1:${good.slice(0, 42)}B=`, // stray bits: same key as another spelling
    ]) {
      expect(code(() => envKeyProvider(raw))).toBe("bad_config");
      try {
        envKeyProvider(raw);
      } catch (e) {
        expect(String(e)).not.toContain(canary);
        expect(String(e)).not.toContain(good);
      }
    }
  });
});

describe("nothing secret shows", () => {
  test("a DEK and a provider print without key material", async () => {
    const key = b64();
    const p = envKeyProvider(`k1:${key}`);
    const dek = generateDek();
    const w = await wrapDek(p, dek, "project-1");
    const out = [dek, p, await unwrapDek(p, w, "project-1")].flatMap((x) => [
      JSON.stringify(x),
      Bun.inspect(x),
      String(x),
    ]);
    expect(out.join("\n")).not.toContain(key);
    expect(Bun.inspect(dek)).toBe("Dek {}");
    expect(Object.keys(dek)).toEqual([]);
  });

  test("errors never contain the value, the AAD or a key", () => {
    const dek = generateDek();
    const blob = encrypt(dek, "PLAINTEXT-CANARY", aad("AAD-CANARY"));
    try {
      decrypt(dek, blob, aad("other"));
    } catch (e) {
      const text = `${e} ${(e as Error).stack}`;
      expect(text).not.toContain("PLAINTEXT-CANARY");
      expect(text).not.toContain("AAD-CANARY");
    }
  });
});
