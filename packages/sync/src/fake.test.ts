import { describe, expect, test } from "bun:test";
import { runAdapterConformance } from "./conformance";
import { SyncError } from "./errors";
import { fakeAdapter } from "./fake";

const variants = {
  everything: {},
  "hidden values": { canReadValues: false },
  "no scopes": { supportsScopes: false },
  "no masking": { supportsMasking: false },
  "bare target": { canReadValues: false, supportsScopes: false, supportsMasking: false },
};

for (const [label, caps] of Object.entries(variants)) {
  runAdapterConformance(`fake, ${label}`, async () => ({
    adapter: fakeAdapter(caps).adapter,
    config: { store: "t" },
  }));
}

describe("fake adapter", () => {
  test("two stores are two targets, and a store is reached again by its name", async () => {
    const { adapter, stores } = fakeAdapter();
    const one = adapter.connect(adapter.validate({ store: "one" }));
    const two = adapter.connect(adapter.validate({ store: "two" }));
    await one.create({ key: "K", scope: "*", value: "v", secret: false });
    expect(await two.read()).toEqual([]);
    const again = adapter.connect(adapter.validate({ store: "one" }));
    expect((await again.read()).map((i) => i.key)).toEqual(["K"]);
    expect([...stores.keys()]).toEqual(["one", "two"]);
  });

  test("a config needs a store name", () => {
    const { adapter } = fakeAdapter();
    for (const bad of [{}, { store: "" }, { store: 1 }, null, "one"]) {
      expect(() => adapter.validate(bad)).toThrow(SyncError);
    }
  });
});
