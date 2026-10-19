import { RotationError } from "./errors";
import type { Rotator } from "./types";

const ALPHABETS = {
  alphanumeric: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  hex: "0123456789abcdef",
  base64url: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
  numeric: "0123456789",
} as const;

export type RandomAlphabet = keyof typeof ALPHABETS;

export const RANDOM_LENGTH = { min: 8, max: 256, default: 32 } as const;

export interface RandomConfig {
  length: number;
  alphabet: RandomAlphabet;
}

/** `length` characters from `alphabet`, drawn without modulo bias from the platform's CSPRNG. */
export function randomString(length: number, alphabet: RandomAlphabet): string {
  const chars = ALPHABETS[alphabet];
  // a byte at or above this would favour the first characters of the alphabet: draw again
  const limit = 256 - (256 % chars.length);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += chars[byte % chars.length];
    }
  }
  return out;
}

const bad = (why: string) => new RotationError("invalid_config", `random: ${why}`);

/** The `random` provider: no external system, so there is nothing to keep alive or to revoke. */
export const randomRotator: Rotator<RandomConfig> = {
  type: "random",
  external: false,
  validate(config) {
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw bad("the config is { length?, alphabet? }");
    }
    const {
      length = RANDOM_LENGTH.default,
      alphabet = "alphanumeric",
      ...rest
    } = config as Record<string, unknown>;
    // the key names are the caller's text: say how many, not which
    if (Object.keys(rest).length > 0) throw bad("the config has a setting this provider lacks");
    if (
      typeof length !== "number" ||
      !Number.isInteger(length) ||
      length < RANDOM_LENGTH.min ||
      length > RANDOM_LENGTH.max
    ) {
      throw bad(`length is a whole number from ${RANDOM_LENGTH.min} to ${RANDOM_LENGTH.max}`);
    }
    if (typeof alphabet !== "string" || !Object.hasOwn(ALPHABETS, alphabet)) {
      throw bad(`alphabet is one of ${Object.keys(ALPHABETS).join(", ")}`);
    }
    return { length, alphabet: alphabet as RandomAlphabet };
  },
  async rotate({ config }) {
    return { value: randomString(config.length, config.alphabet), handle: null };
  },
  async revoke() {},
};
