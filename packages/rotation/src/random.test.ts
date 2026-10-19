import { describe, expect, test } from "bun:test";
import { RotationError } from "./errors";
import { RANDOM_LENGTH, randomRotator, randomString } from "./random";

const scope = { organizationId: "org-1" };

const rotate = async (config: unknown) =>
  (await randomRotator.rotate({ config: randomRotator.validate(config), key: "K", ...scope }))
    .value;

describe("random provider", () => {
  test("defaults to 32 alphanumeric characters and has nothing to revoke", async () => {
    const config = randomRotator.validate({});
    expect(config).toEqual({ length: 32, alphabet: "alphanumeric" });
    const minted = await randomRotator.rotate({ config, key: "K", ...scope });
    expect(minted.value).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(minted.handle).toBeNull();
    await randomRotator.revoke(config, "anything", scope);
  });

  test("honours the length and every alphabet", async () => {
    expect(await rotate({ length: 8, alphabet: "hex" })).toMatch(/^[0-9a-f]{8}$/);
    expect(await rotate({ length: 64, alphabet: "base64url" })).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(await rotate({ length: 100, alphabet: "numeric" })).toMatch(/^[0-9]{100}$/);
    expect((await rotate({ length: RANDOM_LENGTH.max })).length).toBe(RANDOM_LENGTH.max);
  });

  test("every character of an alphabet turns up, with no character favoured", () => {
    // a plain `byte % 62` would give the first 8 characters of the alphabet 5/4 of the rest
    const counts = new Map<string, number>();
    const n = 62_000;
    for (let done = 0; done < n; done += 250) {
      for (const c of randomString(250, "alphanumeric")) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    expect(counts.size).toBe(62);
    const expected = n / 62;
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.75);
      expect(count).toBeLessThan(expected * 1.25);
    }
  });

  test("two rotations differ", async () => {
    expect(await rotate({})).not.toBe(await rotate({}));
  });

  test("refuses a bad config with a reason that does not echo the input", () => {
    const canary = "never-in-an-error-3b1c";
    const configs = [
      { length: 7 },
      { length: RANDOM_LENGTH.max + 1 },
      { length: 12.5 },
      { length: "12" },
      { length: Number.NaN },
      { alphabet: "emoji" },
      { alphabet: "__proto__" },
      { alphabet: 3 },
      { [canary]: canary },
      { length: canary },
      { alphabet: canary },
      [],
      null,
    ];
    for (const config of configs) {
      let error: unknown;
      try {
        randomRotator.validate(config);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(RotationError);
      expect((error as RotationError).kind).toBe("invalid_config");
      expect((error as RotationError).message).not.toContain(canary);
    }
  });
});
