import { describe, expect, test } from "bun:test";
import { RotationError } from "./errors";
import { fakeRotator } from "./fake";
import { randomRotator } from "./random";
import { runRotatorConformance } from "./testing";

const scope = { organizationId: "org-1" };

runRotatorConformance("fake", async () => ({
  rotator: fakeRotator().rotator,
  config: { name: "a" },
}));
runRotatorConformance("fake, not external", async () => ({
  rotator: fakeRotator({ external: false }).rotator,
  config: { name: "a" },
}));
runRotatorConformance("random", async () => ({ rotator: randomRotator, config: {} }));

describe("fake rotator", () => {
  test("records mints and revokes in order and tracks what is still live", async () => {
    const { rotator, calls, live } = fakeRotator();
    const config = rotator.validate({ name: "db" });
    const first = await rotator.rotate({ config, key: "PW", ...scope });
    const second = await rotator.rotate({ config, key: "PW", ...scope });
    expect([...live]).toEqual([first.handle as string, second.handle as string]);
    await rotator.revoke(config, first.handle as string, scope);
    expect([...live]).toEqual([second.handle as string]);
    expect(calls.map((c) => c.op)).toEqual(["mint", "mint", "revoke"]);
  });

  test("a failure names its kind and never a value that was minted", async () => {
    const { rotator, failWith } = fakeRotator();
    const config = rotator.validate({ name: "db" });
    const { value } = await rotator.rotate({ config, key: "PW", ...scope });
    failWith("denied");
    for (const call of [
      () => rotator.rotate({ config, key: "PW", ...scope }),
      () => rotator.revoke(config, "db-handle-1", scope),
    ]) {
      const error = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(RotationError);
      expect((error as RotationError).kind).toBe("denied");
      expect((error as RotationError).message).not.toContain(value);
    }
    failWith(null);
    await rotator.rotate({ config, key: "PW", ...scope });
  });
});
