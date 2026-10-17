// biome-ignore-all lint/suspicious/noTemplateCurlyInString: a value that looks like a reference is the point
import { afterAll, describe, expect, test } from "bun:test";
import { SyncError, type SyncErrorKind } from "./errors";
import {
  ALL_SCOPES,
  type ItemInput,
  type Remote,
  type RemoteItem,
  type SyncAdapter,
} from "./types";

/** A target that is empty and the adapter and config that reach it. Called once per test. */
export interface ConformanceTarget<C = unknown> {
  adapter: SyncAdapter<C>;
  config: unknown;
  stop?: () => void | Promise<void>;
}

/** A value that must never show up in an error. */
const CANARY = "conformance-canary-7f3a9c";

async function failsWith(kind: SyncErrorKind, p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    const err = e as SyncError;
    expect(err.kind).toBe(kind);
    expect(err.message).not.toContain(CANARY);
    return;
  }
  throw new Error(`expected a ${kind} error`);
}

const item = (key: string, value: string, scope = ALL_SCOPES, secret = false): ItemInput => ({
  key,
  scope,
  value,
  secret,
});
const ids = (items: RemoteItem[]) => items.map((i) => `${i.key}@${i.scope}`);

/**
 * The behaviour every target must show, whatever it is made of. It runs against the fake
 * (`fake.test.ts`) and, for each real adapter, against its mock or a sandbox, so a mock can only
 * say what the target says. `setup` gives an empty target each time it is called.
 */
export function runAdapterConformance<C>(
  label: string,
  setup: () => Promise<ConformanceTarget<C>>,
) {
  describe(`sync adapter conformance: ${label}`, () => {
    const stops: (() => void | Promise<void>)[] = [];
    afterAll(async () => {
      for (const stop of stops) await stop();
    });
    const fresh = async () => {
      const t = await setup();
      if (t.stop) stops.push(t.stop);
      const config = t.adapter.validate(t.config);
      return {
        adapter: t.adapter,
        caps: t.adapter.capabilities,
        remote: t.adapter.connect(config),
      };
    };
    /** What a read shows for a value, as far as the target can show it. */
    const shown = (caps: { canReadValues: boolean }, value: string) =>
      caps.canReadValues ? value : null;

    test("takes the config it was given and refuses what is not a config, without echoing it", async () => {
      const t = await setup();
      if (t.stop) stops.push(t.stop);
      expect(() => t.adapter.validate(t.config)).not.toThrow();
      const refused = (config: unknown) => {
        try {
          t.adapter.validate(config);
        } catch (e) {
          return e;
        }
      };
      for (const bad of [undefined, null, 42, "x", [], true, CANARY, [CANARY]]) {
        const e = refused(bad);
        expect(e).toBeInstanceOf(SyncError);
        expect((e as SyncError).kind).toBe("invalid_config");
        expect((e as SyncError).message).not.toContain(CANARY);
      }
      // A config with credentials in it may be taken or refused, but never repeated.
      const e = refused({ ...(t.config as object), token: CANARY, password: CANARY });
      if (e) {
        expect(e).toBeInstanceOf(SyncError);
        expect((e as SyncError).message).not.toContain(CANARY);
      }
    });

    test("an empty target reads as nothing", async () => {
      const { remote } = await fresh();
      expect(await remote.read()).toEqual([]);
    });

    test("a created item is read back as it was made, a value only if the target can show one", async () => {
      const { remote, caps } = await fresh();
      await remote.create(item("API_URL", "https://example.test"));
      expect(await remote.read()).toEqual([
        {
          key: "API_URL",
          scope: ALL_SCOPES,
          value: shown(caps, "https://example.test"),
          secret: false,
        },
      ]);
    });

    test("values are kept exactly: lines, quotes, spaces, references and unicode", async () => {
      const { remote, caps } = await fresh();
      const values = {
        V_LINES: "one\ntwo\r\nthree\n",
        V_QUOTES: `say "hi" and 'bye' and \`ticks\``,
        V_SPACES: "  padded  ",
        V_REF: "${OTHER} and $PLAIN and %PCT%",
        V_UNICODE: "naïve – 日本語 – 🙂",
        V_SYMBOLS: "a=b&c=d;e|f<g>h\\i/j",
      };
      for (const [k, v] of Object.entries(values)) await remote.create(item(k, v));
      const read = await remote.read();
      expect(read.map((i) => i.key)).toEqual(Object.keys(values).sort());
      for (const i of read) {
        expect(i.value).toBe(shown(caps, values[i.key as keyof typeof values]));
      }
    });

    test("creating what is there fails with exists and changes nothing", async () => {
      const { remote, caps } = await fresh();
      await remote.create(item("DUP", "first"));
      await failsWith("exists", remote.create(item("DUP", CANARY)));
      expect(await remote.read()).toEqual([
        { key: "DUP", scope: ALL_SCOPES, value: shown(caps, "first"), secret: false },
      ]);
    });

    test("an update replaces the value, and the same update again changes nothing", async () => {
      const { remote, caps } = await fresh();
      await remote.create(item("UPD", "old"));
      await remote.create(item("KEEP", "kept"));
      await remote.update(item("UPD", "new"));
      const once = await remote.read();
      expect(once.find((i) => i.key === "UPD")?.value).toBe(shown(caps, "new"));
      expect(once.find((i) => i.key === "KEEP")?.value).toBe(shown(caps, "kept"));
      await remote.update(item("UPD", "new"));
      expect(await remote.read()).toEqual(once);
    });

    test("updating or deleting what is not there fails with not_found and creates nothing", async () => {
      const { remote } = await fresh();
      await failsWith("not_found", remote.update(item("NOPE", CANARY)));
      await failsWith("not_found", remote.delete({ key: "NOPE", scope: ALL_SCOPES }));
      expect(await remote.read()).toEqual([]);
      // a key is compared as a whole too: neither a part of it nor an extension of it is it
      await remote.create(item("ABC", "v"));
      for (const key of ["AB", "ABCD", "abc"]) {
        await failsWith("not_found", remote.update(item(key, CANARY)));
        await failsWith("not_found", remote.delete({ key, scope: ALL_SCOPES }));
      }
      expect(ids(await remote.read())).toEqual(["ABC@*"]);
    });

    test("a delete removes only that item, and a second delete is not_found", async () => {
      const { remote } = await fresh();
      await remote.create(item("GONE", "g"));
      await remote.create(item("STAYS", "s"));
      await remote.delete({ key: "GONE", scope: ALL_SCOPES });
      expect(ids(await remote.read())).toEqual(["STAYS@*"]);
      await failsWith("not_found", remote.delete({ key: "GONE", scope: ALL_SCOPES }));
      await remote.create(item("GONE", "again"));
      expect(ids(await remote.read())).toEqual(["GONE@*", "STAYS@*"]);
    });

    test("reads are ordered by key and then scope, in code units", async () => {
      const { remote, caps } = await fresh();
      const order = caps.supportsScopes
        ? [
            item("B", "1", "prod"),
            item("a", "2"),
            item("B", "3"),
            item("A", "4", "dev"),
            item("A", "5"),
          ]
        : [item("B", "1"), item("a", "2"), item("A", "5")];
      for (const i of order) await remote.create(i);
      const read = ids(await remote.read());
      const expected = caps.supportsScopes
        ? ["A@*", "A@dev", "B@*", "B@prod", "a@*"]
        : ["A@*", "B@*", "a@*"];
      expect(read).toEqual(expected);
    });

    test("what read returns is a copy: changing it changes nothing in the target", async () => {
      const { remote, caps } = await fresh();
      await remote.create(item("COPY", "v"));
      const first = await remote.read();
      first.length = 0;
      const again = await remote.read();
      expect(again).toHaveLength(1);
      for (const i of again) i.value = CANARY;
      expect((await remote.read())[0]?.value).toBe(shown(caps, "v"));
    });

    test("a key is its own item in each scope, and a scope never falls back to *", async () => {
      const { remote, caps } = await fresh();
      if (!caps.supportsScopes) {
        for (const scope of ["production", "staging/*"]) {
          await failsWith("unsupported", remote.create(item("K", CANARY, scope)));
          await failsWith("unsupported", remote.update(item("K", CANARY, scope)));
          await failsWith("unsupported", remote.delete({ key: "K", scope }));
        }
        expect(await remote.read()).toEqual([]);
        return;
      }
      await remote.create(item("K", "everywhere"));
      await remote.create(item("K", "production", "production"));
      expect(ids(await remote.read())).toEqual(["K@*", "K@production"]);
      await failsWith("not_found", remote.update(item("K", CANARY, "staging")));
      await failsWith("not_found", remote.delete({ key: "K", scope: "staging" }));
      await remote.update(item("K", "production-2", "production"));
      await remote.delete({ key: "K", scope: ALL_SCOPES });
      const left = await remote.read();
      expect(ids(left)).toEqual(["K@production"]);
      expect(left[0]?.value).toBe(shown(caps, "production-2"));
      // a scope is compared as a whole: a prefix or a wildcard of it is another scope
      await failsWith("not_found", remote.update(item("K", CANARY, "prod")));
      await failsWith("not_found", remote.delete({ key: "K", scope: "production*" }));
    });

    test("a secret is kept as a secret, and can be made plain; a target that cannot mask refuses one", async () => {
      const { remote, caps } = await fresh();
      if (!caps.supportsMasking) {
        await failsWith("unsupported", remote.create(item("S", CANARY, ALL_SCOPES, true)));
        await remote.create(item("P", "p"));
        await failsWith("unsupported", remote.update(item("P", CANARY, ALL_SCOPES, true)));
        // what can never work is refused before the target is asked whether the item is there
        await failsWith("unsupported", remote.update(item("Q", CANARY, ALL_SCOPES, true)));
        expect(await remote.read()).toEqual([
          { key: "P", scope: ALL_SCOPES, value: shown(caps, "p"), secret: false },
        ]);
        return;
      }
      await remote.create(item("S", "hidden-value", ALL_SCOPES, true));
      expect((await remote.read())[0]).toMatchObject({ key: "S", secret: true });
      await remote.update(item("S", "hidden-value", ALL_SCOPES, false));
      expect((await remote.read())[0]).toMatchObject({ key: "S", secret: false });
      await remote.update(item("S", "hidden-again", ALL_SCOPES, true));
      expect((await remote.read())[0]).toMatchObject({ key: "S", secret: true });
    });

    test("a hidden value is null, never an empty string or a mask", async () => {
      const { remote, caps } = await fresh();
      await remote.create(item("H", "something"));
      const [read] = await remote.read();
      if (caps.canReadValues) expect(read?.value).toBe("something");
      else expect(read?.value).toBeNull();
    });

    test("an empty key or scope is invalid, and nothing is written", async () => {
      const { remote } = await fresh();
      await failsWith("invalid", remote.create(item("", CANARY)));
      await failsWith("invalid", remote.create(item("K", CANARY, "")));
      await failsWith("invalid", remote.update(item("", CANARY)));
      await failsWith("invalid", remote.delete({ key: "", scope: ALL_SCOPES }));
      expect(await remote.read()).toEqual([]);
    });

    test("no failure carries a value", async () => {
      const { remote, caps } = await fresh();
      await remote.create(item("F", "present"));
      const mustFail = [
        () => remote.create(item("F", CANARY)),
        () => remote.update(item("NOPE", CANARY)),
        () => remote.create(item("", CANARY)),
      ];
      // A target that takes a secret or a scope has nothing to refuse there.
      const mayFail = [
        () => remote.create(item("K1", CANARY, ALL_SCOPES, !caps.supportsMasking)),
        () => remote.create(item("K2", CANARY, caps.supportsScopes ? "" : "other")),
      ];
      for (const attempt of mustFail) {
        const e = await attempt().then(
          () => undefined,
          (x: unknown) => x,
        );
        expect(e).toBeInstanceOf(SyncError);
        expect((e as SyncError).message).not.toContain(CANARY);
      }
      for (const attempt of mayFail) {
        await attempt().catch((e: unknown) => {
          expect(e).toBeInstanceOf(SyncError);
          expect((e as SyncError).message).not.toContain(CANARY);
        });
      }
    });

    test("one target does not see another", async () => {
      const a = await fresh();
      const b = await fresh();
      await a.remote.create(item("ONLY_A", "a"));
      expect(await b.remote.read()).toEqual([]);
    });
  });
}

export type { Remote };
