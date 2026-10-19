import { RotationError, type RotationErrorKind } from "./errors";
import type { Rotator } from "./types";

export interface FakeConfig {
  /** Which in-memory credential family: two names are two providers' worth of state. */
  name: string;
}

export type FakeCall =
  | { op: "mint"; key: string; handle: string }
  | { op: "revoke"; handle: string };

/**
 * A provider over memory, for tests of the rotation engine and the reference the conformance suite
 * is proven against. `calls` is every mint and revoke in order; `live` is what is minted and not
 * yet revoked, so a test can say "the old credential is still valid" or "it was revoked".
 */
export function fakeRotator(opts: { external?: boolean } = {}) {
  const external = opts.external ?? true;
  const calls: FakeCall[] = [];
  const live = new Set<string>();
  let minted = 0;
  let failure: RotationErrorKind | null = null;

  const rotator: Rotator<FakeConfig> = {
    type: "fake",
    external,
    validate(config) {
      const name = (config as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || !name) {
        throw new RotationError("invalid_config", "the config is { name: <name> }");
      }
      return { name };
    },
    async rotate({ config, key }) {
      if (failure) throw new RotationError(failure, "fake: told to fail");
      minted += 1;
      const value = `${config.name}-secret-${minted}`;
      if (!external) return { value, handle: null };
      const handle = `${config.name}-handle-${minted}`;
      calls.push({ op: "mint", key, handle });
      live.add(handle);
      return { value, handle };
    },
    async revoke(_config, handle) {
      if (failure) throw new RotationError(failure, "fake: told to fail");
      calls.push({ op: "revoke", handle });
      live.delete(handle);
    },
  };

  return {
    rotator,
    calls,
    live,
    /** Every call fails with this kind until called with `null`. */
    failWith(kind: RotationErrorKind | null) {
      failure = kind;
    },
  };
}
