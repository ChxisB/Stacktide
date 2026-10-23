import { describe, expect, test } from "bun:test";
import type { Jwk } from "@orch/gitlab";
import { IdTokenError, keyCache, peekIssuer, verifyIdToken } from "./id-token";
import { b64, makeKey, type Signer, sign } from "./jwt-testing";

const ISSUER = "https://gitlab.example.com";
const AUDIENCE = "orch.example.com";
const NOW = 1_800_000_000_000;
const SECONDS = NOW / 1000;

const claimsOk = {
  iss: ISSUER,
  aud: AUDIENCE,
  sub: "project_path:acme/web:ref_type:branch:ref:main",
  exp: SECONDS + 300,
  iat: SECONDS - 5,
  nbf: SECONDS - 5,
};

const reasonOf = (p: Promise<unknown>) =>
  p.then(
    () => "accepted",
    (e) => (e instanceof IdTokenError ? e.reason : `not an IdTokenError: ${e}`),
  );

let signer: Signer;
let other: Signer;
const setup = (async () => {
  [signer, other] = [await makeKey("k1"), await makeKey("k2")];
})();
const verify = async (token: string, over: Partial<Parameters<typeof verifyIdToken>[1]> = {}) => {
  await setup;
  return verifyIdToken(token, {
    key: async (kid) => [signer, other].find((k) => k.kid === kid)?.jwk,
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
    ...over,
  });
};
const claims = (over: Record<string, unknown>) => ({ ...claimsOk, ...over });

describe("verifyIdToken", () => {
  test("a valid token gives its claims", async () => {
    await setup;
    const out = await verify(await sign(signer, { ...claimsOk, project_id: "42" }));
    expect(out).toMatchObject({ sub: claimsOk.sub, exp: claimsOk.exp, project_id: "42" });
  });

  test("the audience may be one of several", async () => {
    await setup;
    expect(await reasonOf(verify(await sign(signer, claims({ aud: ["x", AUDIENCE] }))))).toBe(
      "accepted",
    );
    expect(await reasonOf(verify(await sign(signer, claims({ aud: ["x", "y"] }))))).toBe(
      "audience",
    );
  });

  test("each way a token can be wrong has its own reason", async () => {
    await setup;
    const cases: [string, Record<string, unknown>, string][] = [
      ["wrong audience", claims({ aud: "someone-else" }), "audience"],
      ["no audience", { ...claimsOk, aud: undefined }, "audience"],
      ["audience a prefix of ours", claims({ aud: AUDIENCE.slice(0, -1) }), "audience"],
      ["audience not text", claims({ aud: 1 }), "audience"],
      ["wrong issuer", claims({ iss: "https://evil.example.com" }), "issuer"],
      ["issuer with a trailing slash", claims({ iss: `${ISSUER}/` }), "issuer"],
      ["no issuer", { ...claimsOk, iss: undefined }, "issuer"],
      ["expired", claims({ exp: SECONDS - 31 }), "expired"],
      ["expired exactly at the leeway", claims({ exp: SECONDS - 30 }), "expired"],
      ["no expiry", { ...claimsOk, exp: undefined }, "claims"],
      ["expiry as text", claims({ exp: String(SECONDS + 300) }), "claims"],
      ["not yet valid", claims({ nbf: SECONDS + 31 }), "not_yet_valid"],
      ["nbf as text", claims({ nbf: "0" }), "claims"],
      ["no subject", { ...claimsOk, sub: undefined }, "claims"],
      ["empty subject", claims({ sub: "" }), "claims"],
    ];
    for (const [name, c, reason] of cases) {
      expect([name, await reasonOf(verify(await sign(signer, c)))]).toEqual([name, reason]);
    }
  });

  test("a little clock skew is fine; a token without nbf is fine", async () => {
    await setup;
    expect(await reasonOf(verify(await sign(signer, claims({ exp: SECONDS - 29 }))))).toBe(
      "accepted",
    );
    expect(await reasonOf(verify(await sign(signer, claims({ nbf: SECONDS + 29 }))))).toBe(
      "accepted",
    );
    expect(await reasonOf(verify(await sign(signer, { ...claimsOk, nbf: undefined })))).toBe(
      "accepted",
    );
  });

  test("the signature must match the key named by kid", async () => {
    await setup;
    // Signed by k2, claiming to be k1; and a payload changed after signing.
    expect(await reasonOf(verify(await sign(other, claimsOk, { kid: "k1" })))).toBe("signature");
    const [h, , s] = (await sign(signer, claimsOk)).split(".");
    expect(
      await reasonOf(verify(`${h}.${b64(claims({ aud: AUDIENCE, sub: "admin" }))}.${s}`)),
    ).toBe("signature");
    expect(await reasonOf(verify(`${h}.${b64(claimsOk)}.`))).toBe("malformed");
  });

  test("the algorithm is not the token's to choose", async () => {
    await setup;
    for (const alg of ["none", "HS256", "RS384", "ES256", "rs256", undefined]) {
      const token = await sign(signer, claimsOk, { alg });
      expect([alg, await reasonOf(verify(token))]).toEqual([alg, "algorithm"]);
    }
    // HS256 "signed" with the public key as the secret (the classic confusion): refused on `alg`.
    await setup;
    const head = b64({ alg: "HS256", kid: "k1" });
    const body = b64(claimsOk);
    const mac = new Bun.CryptoHasher("sha256", signer.jwk.n)
      .update(`${head}.${body}`)
      .digest("base64url");
    expect(await reasonOf(verify(`${head}.${body}.${mac}`))).toBe("algorithm");
    expect(await reasonOf(verify(`${b64({ alg: "none", kid: "k1" })}.${body}.`))).toBe("malformed");
  });

  test("an unknown or missing kid, or an unusable key, is refused", async () => {
    await setup;
    expect(await reasonOf(verify(await sign(signer, claimsOk, { kid: "nope" })))).toBe(
      "unknown_key",
    );
    expect(await reasonOf(verify(await sign(signer, claimsOk, { kid: undefined })))).toBe(
      "unknown_key",
    );
    expect(await reasonOf(verify(await sign(signer, claimsOk, { kid: 7 })))).toBe("unknown_key");
    const weak = await makeKey("weak", 1024);
    expect(await reasonOf(verify(await sign(weak, claimsOk), { key: async () => weak.jwk }))).toBe(
      "unknown_key",
    );
    const broken = { ...signer.jwk, e: "!!" };
    expect(await reasonOf(verify(await sign(signer, claimsOk), { key: async () => broken }))).toBe(
      "signature",
    );
    const wrongType = { ...signer.jwk, kty: "EC" } as unknown as Jwk;
    expect(
      await reasonOf(verify(await sign(signer, claimsOk), { key: async () => wrongType })),
    ).toBe("unknown_key");
  });

  test("anything that is not a three-part JWT is malformed", async () => {
    await setup;
    const good = await sign(signer, claimsOk);
    const [h, p, s] = good.split(".") as [string, string, string];
    for (const bad of [
      "",
      "a",
      "a.b",
      `${good}.extra`,
      `${h}.${p}.${s}=`,
      `${h}.${p} .${s}`,
      `${h}..${s}`,
      `${b64([1])}.${p}.${s}`,
      `${Buffer.from("{nope").toString("base64url")}.${p}.${s}`,
      `${b64("text")}.${p}.${s}`,
      "x".repeat(9000),
    ]) {
      expect([bad.slice(0, 20), await reasonOf(verify(bad))]).toEqual([
        bad.slice(0, 20),
        "malformed",
      ]);
    }
    expect(await reasonOf(verify(`${h}.${Buffer.from("[1]").toString("base64url")}.${s}`))).toBe(
      "signature",
    );
  });

  test("a key source that fails fails the verification: nothing is guessed", async () => {
    await setup;
    const token = await sign(signer, claimsOk);
    await expect(
      verify(token, { key: () => Promise.reject(new Error("gitlab down")) }),
    ).rejects.toThrow("gitlab down");
  });

  test("the refusal never carries the token", async () => {
    await setup;
    const token = await sign(signer, claims({ aud: "x" }));
    const error = await verify(token).catch((e) => e as Error);
    expect(error.message).toBe("id_token refused: audience");
    expect(String(error.stack)).not.toContain(token.split(".")[2]);
  });
});

describe("keyCache", () => {
  const k = (kid: string): Jwk => ({ kty: "RSA", kid, n: "n", e: "e" });
  function source(sets: Jwk[][]) {
    let calls = 0;
    let at = 0;
    let fail = false;
    const now = () => at;
    const fetch = async () => {
      calls++;
      if (fail) throw new Error("gitlab down");
      return sets[Math.min(calls, sets.length) - 1] ?? [];
    };
    return {
      get: keyCache({ fetch, ttlMs: 1000, minRefetchMs: 100, now }),
      calls: () => calls,
      tick: (ms: number) => {
        at += ms;
      },
      down: (v: boolean) => {
        fail = v;
      },
    };
  }

  test("keys are fetched once and kept for the TTL, to the millisecond", async () => {
    const s = source([[k("a")]]);
    expect((await s.get("a"))?.kid).toBe("a");
    expect((await s.get("a"))?.kid).toBe("a");
    expect(s.calls()).toBe(1);
    s.tick(999);
    await s.get("a");
    expect(s.calls()).toBe(1);
    s.tick(1);
    await s.get("a");
    expect(s.calls()).toBe(2);
  });

  test("an unknown kid refetches once, then not again within the minimum gap", async () => {
    const s = source([[k("a")], [k("a"), k("b")]]);
    await s.get("a");
    s.tick(50);
    expect(await s.get("b")).toBeUndefined(); // too soon: GitLab is not asked
    expect(s.calls()).toBe(1);
    s.tick(50);
    expect((await s.get("b"))?.kid).toBe("b"); // rotated keys are picked up
    expect(s.calls()).toBe(2);
    expect(await s.get("zzz")).toBeUndefined();
    expect(await s.get("zzz")).toBeUndefined();
    expect(s.calls()).toBe(2); // still within the minimum gap
    s.tick(100);
    expect(await s.get("zzz")).toBeUndefined();
    expect(s.calls()).toBe(3);
  });

  test("a failed fetch throws, is not cached, and no expired key is served in its place", async () => {
    const s = source([[k("a")]]);
    await s.get("a");
    s.tick(1000);
    s.down(true);
    await expect(s.get("a")).rejects.toThrow("gitlab down");
    s.tick(100);
    await expect(s.get("a")).rejects.toThrow("gitlab down");
    s.down(false);
    s.tick(100);
    expect((await s.get("a"))?.kid).toBe("a");
  });

  test("after a failed fetch GitLab is left alone for the minimum gap, then asked again", async () => {
    const s = source([[k("a")]]);
    s.down(true);
    await expect(s.get("a")).rejects.toThrow("gitlab down");
    expect(s.calls()).toBe(1);
    s.tick(99);
    s.down(false);
    await expect(s.get("a")).rejects.toThrow("gitlab down"); // the same failure, no new fetch
    await expect(s.get("zzz")).rejects.toThrow("gitlab down");
    expect(s.calls()).toBe(1);
    s.tick(1);
    expect((await s.get("a"))?.kid).toBe("a");
    expect(s.calls()).toBe(2);
  });

  test("a failed refetch for an unknown kid throws too", async () => {
    const s = source([[k("a")]]);
    await s.get("a");
    s.tick(200);
    s.down(true);
    await expect(s.get("b")).rejects.toThrow("gitlab down");
    expect((await s.get("a").catch(() => undefined))?.kid ?? "a").toBe("a");
  });

  test("callers at the same moment share one fetch", async () => {
    const s = source([[k("a")]]);
    const all = await Promise.all([s.get("a"), s.get("a"), s.get("a")]);
    expect(all.every((x) => x?.kid === "a")).toBe(true);
    expect(s.calls()).toBe(1);
  });
});

describe("peekIssuer", () => {
  test("reads the issuer a token claims, signed or not, and nothing from anything else", async () => {
    await setup;
    expect(peekIssuer(await sign(signer, claimsOk))).toBe(ISSUER);
    // not verified: a forged token names whatever it likes, and that is all this says
    expect(peekIssuer(await sign(other, { ...claimsOk, iss: "https://elsewhere.example" }))).toBe(
      "https://elsewhere.example",
    );
    for (const bad of [
      "",
      "not-a-jwt",
      "a.b.c",
      `a.${b64({ no: "iss" })}.c`,
      `a.${b64({ iss: 5 })}.c`,
      `a.${b64({ iss: "" })}.c`,
      `a.${b64([1])}.c`,
      "a.%%%.c",
      `a.${b64({ iss: ISSUER })}`,
    ]) {
      expect(peekIssuer(bad)).toBeUndefined();
    }
  });
});
