import { afterAll, describe, expect, test } from "bun:test";
import { RotationError } from "./errors";
import type { Rotator } from "./types";

/** A provider and a config that reaches it. Called once per test. */
export interface ConformanceTarget<C = unknown> {
  rotator: Rotator<C>;
  config: unknown;
  stop?: () => void | Promise<void>;
}

const scope = { organizationId: "conformance-org" };

/** A value that must never show up in an error. */
const CANARY = "conformance-canary-7f3a9c";

/**
 * The behaviour every provider must show, whatever it is made of. It runs against the fake and the
 * `random` provider and, for each real provider, against its mock or a sandbox, so a mock can only
 * say what the system says.
 */
export function runRotatorConformance<C>(
  label: string,
  setup: () => Promise<ConformanceTarget<C>>,
) {
  describe(`rotator conformance: ${label}`, () => {
    const stops: (() => void | Promise<void>)[] = [];
    afterAll(async () => {
      for (const stop of stops) await stop();
    });
    const fresh = async () => {
      const t = await setup();
      if (t.stop) stops.push(t.stop);
      return { rotator: t.rotator, config: t.rotator.validate(t.config) };
    };

    test("takes the config it was given and refuses what is not a config, without echoing it", async () => {
      const { rotator } = await fresh();
      for (const junk of [null, undefined, 7, "x", [], { [CANARY]: CANARY }, { x: CANARY }]) {
        let error: unknown;
        try {
          rotator.validate(junk);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(RotationError);
        expect((error as RotationError).kind).toBe("invalid_config");
        expect((error as RotationError).message).not.toContain(CANARY);
      }
    });

    test("gives a new, non-empty value each time, and a handle that is not the value", async () => {
      const { rotator, config: first } = await fresh();
      let config = first;
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const minted = await rotator.rotate({ config, key: "DB_PASSWORD", ...scope });
        // the next rotation starts from what this one handed back, as the platform does
        if (minted.config !== undefined) config = rotator.validate(minted.config);
        expect(minted.value.length).toBeGreaterThan(0);
        expect(seen.has(minted.value)).toBe(false);
        seen.add(minted.value);
        // a handle is what an external provider has to undo: both or neither
        expect(minted.handle !== null).toBe(rotator.external);
        if (minted.handle !== null) {
          expect(minted.handle.length).toBeGreaterThan(0);
          expect(minted.handle).not.toContain(minted.value);
        }
      }
    });

    test("an updated config it hands back is a config it accepts", async () => {
      const { rotator, config } = await fresh();
      const minted = await rotator.rotate({ config, key: "TOKEN", ...scope });
      if (minted.config !== undefined) rotator.validate(minted.config);
    });

    test("revoking is idempotent: a handle revoked twice or never minted is done", async () => {
      const { rotator, config } = await fresh();
      const minted = await rotator.rotate({ config, key: "TOKEN", ...scope });
      if (minted.handle === null) return;
      await rotator.revoke(config, minted.handle, scope);
      await rotator.revoke(config, minted.handle, scope);
      await rotator.revoke(config, "never-minted-handle", scope);
    });
  });
}
