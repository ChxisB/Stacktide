import { describe, expect, test } from "bun:test";
import { runAdapterConformance } from "./conformance";
import { SyncError } from "./errors";
import { type FakeKubeOptions, fakeKube } from "./fake-kube";
import type { Fetch } from "./http";
import { KUBE_VERBS, type KubernetesConfig } from "./kubernetes";
import {
  KUBERNETES_SECRET,
  kubernetesSecretAdapter,
  MANAGED_LABEL,
  PLAIN_ANNOTATION,
  parseKubernetesSecretConfig,
} from "./kubernetes-secret";
import { ALL_SCOPES, type ItemInput } from "./types";

const SERVER = "https://k8s.example.test:6443";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.token-CANARY-0123456789";
const CA = "-----BEGIN CERTIFICATE-----\nMIIBkTCB\n-----END CERTIFICATE-----\n";
const LEAK = "kube-leak-CANARY-3c8d";
const VALUE = "value-CANARY-8e41";
const connection: KubernetesConfig = { server: SERVER, namespaces: ["apps", "staging"] };
const target = { namespace: "apps", name: "app-env" };
const NS = "apps";
const NAME = "app-env";

const item = (
  key: string,
  value: string,
  scope = ALL_SCOPES,
  secret = true,
  file = false,
): ItemInput => ({ key, scope, value, secret, file });
const ours = (extra: Record<string, string> = {}) => ({ [MANAGED_LABEL]: NAME, ...extra });

/** A cluster with a namespace, and an adapter that reaches it the way the platform does. */
function world(opts: Partial<FakeKubeOptions> = {}, conn: KubernetesConfig = connection) {
  const kube = fakeKube({
    server: SERVER,
    token: TOKEN,
    namespaces: ["apps", "staging"],
    leak: LEAK,
    ...opts,
  });
  const connect = (
    fetch: Fetch,
    c: unknown = target,
    k: KubernetesConfig = conn,
    token = TOKEN,
  ) => {
    const adapter = kubernetesSecretAdapter(k, token, { fetch });
    return { adapter, remote: adapter.connect(adapter.validate(c)) };
  };
  return {
    kube,
    ...connect(kube.fetch),
    /** The same cluster seen through a fetch that does something between the answers. */
    through: (wrap: (real: Fetch) => Fetch) => connect(wrap(kube.fetch)).remote,
    /** Another target on the same cluster. */
    other: (c: unknown) => connect(kube.fetch, c).remote,
    /** The same target with another token. */
    withToken: (token: string) => connect(kube.fetch, target, conn, token).remote,
  };
}
type World = ReturnType<typeof world>;

const writes = (w: World) => w.kube.calls.filter((c) => c.method !== "GET");
const held = (w: World) => w.kube.secrets.get(`${NS}/${NAME}`);
/** The Secret changed by someone else, as far as the API server can tell. */
const bump = (w: World) => {
  const s = held(w);
  if (s) w.kube.secrets.set(`${NS}/${NAME}`, { ...s, resourceVersion: s.resourceVersion + 1000 });
};
/** A fetch that runs `run` once a call to the method has been answered. */
const racing =
  (method: string, run: () => void): ((real: Fetch) => Fetch) =>
  (real) =>
  async (url, init) => {
    const res = await real(url, init);
    if (init.method === method) run();
    return res;
  };
/** A fetch that answers every call the same. */
const always =
  (make: () => Response): ((real: Fetch) => Fetch) =>
  () =>
  async () =>
    make();
const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    return e as SyncError;
  }
  throw new Error("expected an error");
};

// what no Secret can hold, and what check says before anything is asked
const refused = [
  { item: item("K", "x".repeat(512 * 1024 + 1)), kind: "invalid" as const },
  { item: item("has space", "v"), kind: "invalid" as const },
  { item: item("a/b", "v"), kind: "invalid" as const },
  { item: item(".", "v"), kind: "invalid" as const },
  { item: item("..", "v"), kind: "invalid" as const },
  { item: item("k".repeat(254), "v"), kind: "invalid" as const },
  { item: item("K", "v", "production"), kind: "unsupported" as const },
];
runAdapterConformance(
  "kubernetes-secret (contract fake)",
  async () => ({ adapter: world().adapter, config: target }),
  { refused },
);

describe("the config", () => {
  test("a namespace and a name, and optionally protected", () => {
    expect(parseKubernetesSecretConfig(target)).toEqual(target);
    const full = { ...target, protected: true };
    expect(parseKubernetesSecretConfig(full)).toEqual(full);
    expect(KUBERNETES_SECRET).toBe("kubernetes-secret");
  });

  test("anything else is invalid_config, says what the config is, and repeats nothing", () => {
    for (const bad of [
      {},
      { namespace: NS },
      { name: NAME },
      { ...target, namespace: "Apps" },
      { ...target, name: "App_Env" },
      { ...target, name: "app.env" },
      { ...target, name: "-app" },
      { ...target, name: "a".repeat(64) },
      { ...target, namespace: "" },
      { ...target, namespace: 7 },
      { ...target, protected: "yes" },
      { ...target, token: LEAK },
      { ...target, scope: LEAK },
    ]) {
      const w = world();
      const e = (() => {
        try {
          w.adapter.validate(bad);
        } catch (err) {
          return err as SyncError;
        }
      })();
      expect(e).toBeInstanceOf(SyncError);
      expect(e?.kind).toBe("invalid_config");
      expect(e?.message).toContain("{ namespace, name }");
      expect(e?.message).not.toContain(LEAK);
    }
  });

  test("a namespace the connection does not allow is refused when the config is taken, and again by connect", () => {
    const w = world({ namespaces: ["apps", "kube-system"] });
    const stranger = { namespace: "kube-system", name: NAME };
    const e = (() => {
      try {
        w.adapter.validate(stranger);
      } catch (err) {
        return err as SyncError;
      }
    })();
    expect(e?.kind).toBe("invalid_config");
    expect(e?.message).toBe("the namespace is not one the connection allows");
    // a config that never went through validate gets no further than connect
    expect(() => w.adapter.connect(stranger)).toThrow(
      "the namespace is not one the connection allows",
    );
    // and a name that is not a name never gets into a URL
    for (const bad of [
      { namespace: NS, name: "../x" },
      { namespace: NS, name: "a/b" },
      { namespace: `${NS}/secrets/x/..`, name: NAME },
      { namespace: NS, name: `${NAME}?watch=true` },
    ]) {
      expect(() => w.adapter.connect(bad)).toThrow("the config is { namespace, name }");
    }
    expect(w.kube.calls).toEqual([]);
  });

  test("the allowed namespaces are compared whole", () => {
    const w = world();
    for (const namespace of ["app", "apps2", "staging-1", "ap"]) {
      expect(() => w.adapter.validate({ namespace, name: NAME })).toThrow();
    }
    expect(w.adapter.validate({ namespace: "staging", name: NAME })).toEqual({
      namespace: "staging",
      name: NAME,
    });
  });

  test("a Secret is not scoped and cannot hold files or be left unmasked", () => {
    expect(world().adapter.capabilities).toEqual({
      canReadValues: true,
      supportsMasking: true,
      supportsScopes: false,
      supportsFiles: false,
    });
  });
});

describe("what is sent", () => {
  test("a create is one POST of an Opaque Secret that carries the label, base64 data and no stringData", async () => {
    const w = world();
    await w.remote.create(item("API_KEY", VALUE));
    expect(w.kube.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /api/v1/namespaces/${NS}/secrets/${NAME}`,
      `POST /api/v1/namespaces/${NS}/secrets`,
    ]);
    expect(w.kube.calls[1]?.contentType).toBe("application/json");
    expect(w.kube.calls[1]?.body).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      type: "Opaque",
      metadata: { name: NAME, labels: { [MANAGED_LABEL]: NAME } },
      data: { API_KEY: Buffer.from(VALUE).toString("base64") },
    });
    expect(w.kube.value(NS, NAME, "API_KEY")).toBe(VALUE);
  });

  test("a plain first key is named in the annotation of the new Secret", async () => {
    const w = world();
    await w.remote.create(item("API_URL", "https://example.test", ALL_SCOPES, false));
    expect(held(w)?.annotations).toEqual({ [PLAIN_ANNOTATION]: '["API_URL"]' });
    expect(held(w)?.labels).toEqual(ours());
  });

  test("a write to a Secret that is there is a merge patch of one key, held to the version it read", async () => {
    const w = world();
    await w.remote.create(item("A", "1"));
    await w.remote.create(item("B", "2"));
    const patch = w.kube.calls.at(-1);
    expect(patch?.method).toBe("PATCH");
    expect(patch?.path).toBe(`/api/v1/namespaces/${NS}/secrets/${NAME}`);
    expect(patch?.contentType).toBe("application/merge-patch+json");
    expect(patch?.body).toEqual({
      metadata: { resourceVersion: expect.stringMatching(/^\d+$/) },
      data: { B: Buffer.from("2").toString("base64") },
    });
    // the version it carries is the one the GET before it showed
    expect(writes(w)).toHaveLength(2);
  });

  test("the verbs it uses over a whole life are the ones the connection test asks the token for", async () => {
    const w = world();
    await w.remote.create(item("A", "1"));
    await w.remote.create(item("B", "2", ALL_SCOPES, false));
    await w.remote.update(item("A", "3"));
    await w.remote.delete({ key: "B", scope: ALL_SCOPES });
    await w.remote.read();
    const verb = { GET: "get", POST: "create", PATCH: "patch" } as const;
    const used = new Set(w.kube.calls.map((c) => verb[c.method as keyof typeof verb]));
    expect([...used].sort()).toEqual([...KUBE_VERBS].sort());
  });

  test("the token goes in the Authorization header to the connection's server and nowhere else", async () => {
    const w = world();
    const urls: string[] = [];
    const remote = w.through((real) => async (url, init) => {
      urls.push(url);
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(String(init.body ?? "")).not.toContain(TOKEN);
      return real(url, init);
    });
    await remote.create(item("A", "1"));
    await remote.update(item("A", "2"));
    await remote.delete({ key: "A", scope: ALL_SCOPES });
    await remote.read();
    expect(urls.length).toBeGreaterThan(4);
    expect(urls.every((u) => u.startsWith(`${SERVER}/api/v1/namespaces/${NS}/secrets`))).toBe(true);
  });

  test("a private CA is handed to the connection, and left out when there is none", async () => {
    const w = world({}, { ...connection, ca: CA });
    await w.remote.read();
    expect(w.kube.calls[0]?.tls).toEqual({ ca: CA });
    const plain = world();
    await plain.remote.read();
    expect(plain.kube.calls[0]?.tls).toBeUndefined();
  });

  test("a redirect is not followed and the token goes nowhere else", async () => {
    const w = world();
    const urls: string[] = [];
    const remote = w.through(() => async (url, init) => {
      urls.push(url);
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 307, headers: { location: "https://evil.example/x" } });
    });
    const e = await errorOf(remote.read());
    expect(e.kind).toBe("failed");
    expect(urls).toHaveLength(1);
  });
});

describe("a Secret this platform did not make", () => {
  const strangers: [string, Record<string, string>][] = [
    ["has no labels", {}],
    ["is labelled for another name", { [MANAGED_LABEL]: "someone-else" }],
    ["has the label with no value", { [MANAGED_LABEL]: "" }],
    ["has other labels", { app: NAME, "app.kubernetes.io/managed-by": "Helm" }],
  ];
  for (const [what, labels] of strangers) {
    test(`one that ${what} is never listed, written or emptied`, async () => {
      const w = world();
      w.kube.seed(NS, NAME, { THEIRS: "theirs", K: "theirs-too" }, { labels });
      const before = structuredClone(held(w));
      expect(await w.remote.read()).toEqual([]);
      expect((await errorOf(w.remote.create(item("NEW", VALUE)))).kind).toBe("exists");
      expect((await errorOf(w.remote.create(item("K", VALUE)))).kind).toBe("exists");
      expect((await errorOf(w.remote.update(item("K", VALUE)))).kind).toBe("not_found");
      expect((await errorOf(w.remote.delete({ key: "K", scope: ALL_SCOPES }))).kind).toBe(
        "not_found",
      );
      expect(held(w)).toEqual(before);
      expect(writes(w)).toEqual([]);
    });
  }

  test("a Secret of the same name in another namespace is another Secret", async () => {
    const w = world();
    w.kube.seed("staging", NAME, { K: "staging" }, { labels: ours() });
    expect(await w.remote.read()).toEqual([]);
    await w.remote.create(item("K", "apps"));
    expect(w.kube.value("staging", NAME, "K")).toBe("staging");
    expect(w.kube.value(NS, NAME, "K")).toBe("apps");
  });

  test("another target's Secret in the same namespace is not touched", async () => {
    const w = world();
    const other = w.other({ namespace: NS, name: "other-env" });
    await w.remote.create(item("K", "mine"));
    await other.create(item("K", "theirs"));
    await other.update(item("K", "theirs-2"));
    expect(w.kube.value(NS, NAME, "K")).toBe("mine");
    expect(w.kube.value(NS, "other-env", "K")).toBe("theirs-2");
    expect((await w.remote.read()).map((i) => i.value)).toEqual(["mine"]);
  });

  test("a label with the right key and a name that only starts like ours is not ours", async () => {
    const w = world();
    w.kube.seed(NS, NAME, { K: "x" }, { labels: { [MANAGED_LABEL]: `${NAME}-2` } });
    expect(await w.remote.read()).toEqual([]);
    w.kube.seed(NS, NAME, { K: "x" }, { labels: { "orch-managed-by": NAME } });
    expect(await w.remote.read()).toEqual([]);
  });
});

describe("keys that are not ours in a Secret that is", () => {
  test("stay as they are through creates, updates and deletes, and are listed as secrets", async () => {
    const w = world();
    w.kube.seed(NS, NAME, { HAND: "by-hand" }, { labels: ours() });
    await w.remote.create(item("K", "1"));
    await w.remote.update(item("K", "2"));
    expect(w.kube.value(NS, NAME, "HAND")).toBe("by-hand");
    expect((await w.remote.read()).map((i) => [i.key, i.value, i.secret])).toEqual([
      ["HAND", "by-hand", true],
      ["K", "2", true],
    ]);
    await w.remote.delete({ key: "K", scope: ALL_SCOPES });
    expect(w.kube.value(NS, NAME, "HAND")).toBe("by-hand");
    expect(held(w)?.labels).toEqual(ours());
  });

  test("a key that holds bytes that are not text is not listed and is never replaced", async () => {
    const w = world();
    w.kube.seed(NS, NAME, { K: "text" }, { labels: ours() });
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80]).toString("base64");
    const s = held(w);
    if (s) s.data.BIN = bytes;
    expect((await w.remote.read()).map((i) => i.key)).toEqual(["K"]);
    // a variable of that name does not converge, and the line says why
    const clash = await errorOf(w.remote.create(item("BIN", VALUE)));
    expect(clash.kind).toBe("exists");
    expect(clash.message).toContain("not text");
    expect((await errorOf(w.remote.update(item("BIN", VALUE)))).kind).toBe("not_found");
    expect((await errorOf(w.remote.delete({ key: "BIN", scope: ALL_SCOPES }))).kind).toBe(
      "not_found",
    );
    await w.remote.update(item("K", "text-2"));
    expect(held(w)?.data.BIN).toBe(bytes);
  });

  test("a Secret's own type and metadata are left as they are", async () => {
    const w = world();
    w.kube.seed(
      NS,
      NAME,
      { K: "1" },
      {
        labels: ours({ team: "web" }),
        annotations: { note: "keep" },
        type: "kubernetes.io/opaque",
      },
    );
    await w.remote.update(item("K", "2", ALL_SCOPES, false));
    expect(held(w)?.type).toBe("kubernetes.io/opaque");
    expect(held(w)?.labels).toEqual(ours({ team: "web" }));
    expect(held(w)?.annotations).toEqual({ note: "keep", [PLAIN_ANNOTATION]: '["K"]' });
  });
});

describe("which keys are not secret", () => {
  const plainOf = (w: World) => held(w)?.annotations[PLAIN_ANNOTATION];

  test("the list follows the keys as they are made plain, secret and deleted, in one patch each", async () => {
    const w = world();
    await w.remote.create(item("B", "1", ALL_SCOPES, false));
    expect(plainOf(w)).toBe('["B"]');
    await w.remote.create(item("A", "2", ALL_SCOPES, false));
    expect(plainOf(w)).toBe('["A","B"]');
    await w.remote.create(item("S", "3", ALL_SCOPES, true));
    expect(plainOf(w)).toBe('["A","B"]');
    await w.remote.update(item("S", "3", ALL_SCOPES, false));
    expect(plainOf(w)).toBe('["A","B","S"]');
    await w.remote.update(item("B", "1", ALL_SCOPES, true));
    expect(plainOf(w)).toBe('["A","S"]');
    expect((await w.remote.read()).map((i) => [i.key, i.secret])).toEqual([
      ["A", false],
      ["B", true],
      ["S", false],
    ]);
    await w.remote.delete({ key: "S", scope: ALL_SCOPES });
    expect(plainOf(w)).toBe('["A"]');
    await w.remote.delete({ key: "A", scope: ALL_SCOPES });
    // no plain key left: the annotation goes, it is not left as an empty list
    expect(held(w)?.annotations).toEqual({});
  });

  test("a write that changes no flag leaves the annotation out of the patch", async () => {
    const w = world();
    await w.remote.create(item("A", "1", ALL_SCOPES, false));
    await w.remote.create(item("S", "2", ALL_SCOPES, true));
    await w.remote.update(item("A", "1b", ALL_SCOPES, false));
    await w.remote.update(item("S", "2b", ALL_SCOPES, true));
    for (const c of writes(w).filter((x) => x.method === "PATCH")) {
      expect(Object.keys((c.body as { metadata: object }).metadata)).toEqual(["resourceVersion"]);
    }
  });

  test("an annotation that is not a list of names lists none, so everything reads as a secret", async () => {
    for (const bad of ["not json", '{"A":1}', "[1]", '["A",2]', "null", '"A"', ""]) {
      const w = world();
      w.kube.seed(
        NS,
        NAME,
        { A: "1" },
        { labels: ours(), annotations: { [PLAIN_ANNOTATION]: bad } },
      );
      expect((await w.remote.read()).map((i) => i.secret)).toEqual([true]);
    }
  });

  test("a key listed that is not in the Secret is not made up", async () => {
    const w = world();
    w.kube.seed(
      NS,
      NAME,
      { A: "1" },
      { labels: ours(), annotations: { [PLAIN_ANNOTATION]: '["A","GHOST"]' } },
    );
    expect((await w.remote.read()).map((i) => [i.key, i.secret])).toEqual([["A", false]]);
  });
});

describe("keys and sizes", () => {
  test("a key Kubernetes would refuse is invalid, before anything is asked", async () => {
    const w = world();
    for (const key of [".", "..", "has space", "a/b", "ü", "a\nb", "k".repeat(254)]) {
      expect((await errorOf(w.remote.create(item(key, VALUE)))).kind).toBe("invalid");
      expect((await errorOf(w.remote.update(item(key, VALUE)))).kind).toBe("invalid");
    }
    expect(w.kube.calls).toEqual([]);
  });

  test("a key that is only a name Kubernetes could never hold is not there, for delete", async () => {
    const w = world();
    await w.remote.create(item("K", "v"));
    const asked = w.kube.calls.length;
    for (const key of [".", "..", "a/b", "has space", "k".repeat(254)]) {
      expect((await errorOf(w.remote.delete({ key, scope: ALL_SCOPES }))).kind).toBe("not_found");
    }
    // not even a look at the Secret
    expect(w.kube.calls).toHaveLength(asked);
    expect(w.kube.value(NS, NAME, "K")).toBe("v");
  });

  test("a key the API server would never hold is not listed, even when it is answered", async () => {
    const w = world();
    w.kube.seed(NS, NAME, { A: "1" }, { labels: ours() });
    const remote = w.through((real) => async (url, init) => {
      const res = await real(url, init);
      const s = (await res.json()) as { data: Record<string, string> };
      return Response.json({ ...s, data: { ...s.data, "has space": "AA==", "a/b": "AA==" } });
    });
    expect((await remote.read()).map((i) => i.key)).toEqual(["A"]);
  });

  test("names that are odd for an object are keys like any other", async () => {
    const w = world();
    const keys = [
      "__proto__",
      "constructor",
      "toString",
      "1",
      "007",
      "a.b-c_d",
      "k".repeat(253),
      ".hidden",
    ];
    for (const key of keys) await w.remote.create(item(key, `v-${key.slice(0, 10)}`));
    const read = await w.remote.read();
    expect(read.map((i) => i.key)).toEqual([...keys].sort());
    expect(read.every((i) => i.value === `v-${i.key.slice(0, 10)}`)).toBe(true);
    for (const key of keys) {
      await w.remote.update(item(key, "new"));
      await w.remote.delete({ key, scope: ALL_SCOPES });
    }
    expect(await w.remote.read()).toEqual([]);
    expect(Object.keys(held(w)?.data ?? {})).toEqual([]);
  });

  test("a value of 512 KiB goes in; one byte more, and a Secret that would pass it, are invalid and write nothing", async () => {
    const w = world();
    await w.remote.create(item("BIG", "x".repeat(512 * 1024)));
    expect((await w.remote.read())[0]?.value).toHaveLength(512 * 1024);
    await w.remote.update(item("BIG", "x".repeat(200 * 1024)));
    const calls = w.kube.calls.length;
    expect((await errorOf(w.remote.create(item("OVER", "x".repeat(512 * 1024 + 1))))).kind).toBe(
      "invalid",
    );
    expect(w.kube.calls).toHaveLength(calls);
    // 200 KiB are in: 313 KiB more is too much for one Secret, and the value that is there stays
    const e = await errorOf(w.remote.create(item("MORE", "y".repeat(313 * 1024))));
    expect(e.kind).toBe("invalid");
    expect(e.message).not.toContain("yyyy");
    expect(Object.keys(held(w)?.data ?? {})).toEqual(["BIG"]);
    await w.remote.create(item("MORE", "y".repeat(312 * 1024)));
    // an update counts the key it replaces once
    await w.remote.update(item("BIG", "z".repeat(200 * 1024)));
  });

  test("the size is bytes, not characters", async () => {
    const w = world();
    const wide = "日".repeat(Math.floor((512 * 1024) / 3) + 1);
    expect((await errorOf(w.remote.create(item("W", wide)))).kind).toBe("invalid");
    await w.remote.create(item("W", "日".repeat(Math.floor((512 * 1024) / 3))));
  });

  test("an empty value is a value", async () => {
    const w = world();
    await w.remote.create(item("EMPTY", ""));
    expect((await w.remote.read())[0]).toMatchObject({ key: "EMPTY", value: "" });
    await w.remote.update(item("EMPTY", "now"));
    await w.remote.update(item("EMPTY", ""));
    expect(w.kube.value(NS, NAME, "EMPTY")).toBe("");
  });
});

describe("a delete", () => {
  test("takes the key out and leaves the Secret, labelled and empty, for the pods that mount it", async () => {
    const w = world();
    await w.remote.create(item("ONLY", "1"));
    await w.remote.delete({ key: "ONLY", scope: ALL_SCOPES });
    expect(held(w)).toMatchObject({ data: {}, labels: ours() });
    expect(await w.remote.read()).toEqual([]);
    await w.remote.create(item("ONLY", "again"));
    expect(w.kube.value(NS, NAME, "ONLY")).toBe("again");
    expect(w.kube.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  test("patches the key to null and nothing else of the data", async () => {
    const w = world();
    await w.remote.create(item("A", "1"));
    await w.remote.create(item("B", "2"));
    await w.remote.delete({ key: "A", scope: ALL_SCOPES });
    expect(w.kube.calls.at(-1)?.body).toEqual({
      metadata: { resourceVersion: expect.any(String) },
      data: { A: null },
    });
    expect(w.kube.value(NS, NAME, "B")).toBe("2");
  });
});

describe("a write that races another", () => {
  test("is refused by the API server, writes nothing, and works when it is tried again", async () => {
    const w = world();
    await w.remote.create(item("K", "old"));
    const racer = w.through(racing("GET", () => bump(w)));
    const before = structuredClone(held(w)?.data);
    const e = await errorOf(racer.update(item("K", VALUE)));
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("changed while it was being written");
    expect(held(w)?.data).toEqual(before);
    await w.remote.update(item("K", VALUE));
    expect(w.kube.value(NS, NAME, "K")).toBe(VALUE);
  });

  test("the same for a create into a Secret that is there, and for a delete", async () => {
    const w = world();
    await w.remote.create(item("A", "1"));
    const racer = w.through(racing("GET", () => bump(w)));
    expect((await errorOf(racer.create(item("B", VALUE)))).kind).toBe("failed");
    expect((await errorOf(racer.delete({ key: "A", scope: ALL_SCOPES }))).kind).toBe("failed");
    expect(Object.keys(held(w)?.data ?? {})).toEqual(["A"]);
  });

  test("a Secret made between the check and the create is exists, not an overwrite", async () => {
    const w = world();
    const racer = w.through(
      racing("GET", () => w.kube.seed(NS, NAME, { THEIRS: "theirs" }, { labels: {} })),
    );
    expect((await errorOf(racer.create(item("K", VALUE)))).kind).toBe("exists");
    expect(w.kube.value(NS, NAME, "THEIRS")).toBe("theirs");
    expect(w.kube.value(NS, NAME, "K")).toBeUndefined();
  });

  test("a Secret of ours made between the check and the create is written into, not refused", async () => {
    const w = world();
    let once = true;
    const racer = w.through(
      racing("GET", () => {
        if (!once) return;
        once = false;
        w.kube.seed(NS, NAME, { OTHER: "o" }, { labels: ours() });
      }),
    );
    await racer.create(item("K", VALUE));
    expect(w.kube.value(NS, NAME, "K")).toBe(VALUE);
    expect(w.kube.value(NS, NAME, "OTHER")).toBe("o");
    // it looks once more and no further: a Secret the server will not show is exists
    const stubborn = w.through(() => async (_url, init) => {
      if (init.method === "POST") return Response.json({ message: LEAK }, { status: 409 });
      return Response.json({}, { status: 404 });
    });
    expect((await errorOf(stubborn.create(item("K2", VALUE)))).kind).toBe("exists");
  });

  test("a Secret that went away between the read and the patch is failed, and nothing is made", async () => {
    const w = world();
    await w.remote.create(item("K", "old"));
    const racer = w.through(racing("GET", () => w.kube.secrets.delete(`${NS}/${NAME}`)));
    const gone = await errorOf(racer.update(item("K", VALUE)));
    expect(gone.kind).toBe("failed");
    expect(gone.message).toContain("no longer there");
    expect(held(w)).toBeUndefined();
  });
});

describe("when the cluster does not answer as it should", () => {
  const clean = (e: SyncError) => {
    expect(e.message).not.toContain(LEAK);
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain(VALUE);
    expect(e.message).not.toContain(SERVER);
    return e;
  };

  test("a namespace that is not there, a token that may not, and one that is wrong, are failed in fixed words", async () => {
    const ghost = world({ namespaces: ["staging"] });
    const e404 = clean(await errorOf(ghost.remote.create(item("K", VALUE))));
    expect(e404.kind).toBe("failed");
    expect(e404.message).toContain("404");

    const forbidden = world();
    forbidden.kube.forbidden.add(`GET ${NS}`);
    const e403 = clean(await errorOf(forbidden.remote.read()));
    expect(e403.kind).toBe("failed");
    expect(e403.message).toContain("403");

    const noPatch = world();
    await noPatch.remote.create(item("K", "1"));
    noPatch.kube.forbidden.add(`PATCH ${NS}`);
    expect(clean(await errorOf(noPatch.remote.update(item("K", VALUE)))).message).toContain("403");
    const noPost = world();
    noPost.kube.forbidden.add(`POST ${NS}`);
    expect(clean(await errorOf(noPost.remote.create(item("K", VALUE)))).message).toContain("403");

    const wrong = world();
    const e401 = clean(await errorOf(wrong.withToken("not-the-token-CANARY-9999999").read()));
    expect(e401.message).toContain("401");
    expect(e401.message).not.toContain("not-the-token-CANARY-9999999");
  });

  test("a server error, a network failure and a timeout are failed, and say nothing of what was asked", async () => {
    const w = world();
    const boom = () =>
      Response.json({ message: LEAK, details: TOKEN }, { status: 500, statusText: LEAK });
    const e500 = clean(await errorOf(w.through(always(boom)).read()));
    expect(e500.kind).toBe("failed");
    expect(e500.message).toContain("500");

    const down = w.through(() => async () => {
      throw new Error(`connect ECONNREFUSED ${SERVER} ${LEAK} ${TOKEN}`);
    });
    for (const op of [
      () => down.read(),
      () => down.create(item("K", VALUE)),
      () => down.update(item("K", VALUE)),
      () => down.delete({ key: "K", scope: ALL_SCOPES }),
    ]) {
      const e = clean(await errorOf(op()));
      expect(e.kind).toBe("failed");
    }

    const slow = kubernetesSecretAdapter(connection, TOKEN, {
      fetch: (_url, init) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error(LEAK)));
        }),
      timeoutMs: 20,
    });
    const e = clean(await errorOf(slow.connect(target).read()));
    expect(e.message).toContain("timeout");
  });

  test("an answer that is not a Secret is failed, whatever it says", async () => {
    const w = world();
    const answers: (() => Response)[] = [
      () => new Response(`<html>${LEAK}</html>`, { status: 200 }),
      () => Response.json({ metadata: {} }),
      () => Response.json({ metadata: { resourceVersion: 5 } }),
      () => Response.json({ metadata: { resourceVersion: "1", labels: { [MANAGED_LABEL]: 5 } } }),
      () => Response.json({ metadata: { resourceVersion: "1", labels: ours() }, data: [LEAK] }),
      () => Response.json({ metadata: { resourceVersion: "1", labels: ours() }, data: { K: 5 } }),
      () => Response.json({ metadata: { resourceVersion: "1", labels: ours() }, data: LEAK }),
      () => new Response(null, { status: 204 }),
      () => Response.json({ message: LEAK }, { status: 400 }),
    ];
    for (const answer of answers) {
      const e = clean(await errorOf(w.through(always(answer)).read()));
      expect(e.kind).toBe("failed");
      clean(await errorOf(w.through(always(answer)).update(item("K", VALUE))));
    }
  });

  test("a Secret nobody can change is said to be immutable, and nothing is sent", async () => {
    const w = world();
    w.kube.seed(NS, NAME, { K: "old" }, { labels: ours(), immutable: true });
    for (const op of [
      () => w.remote.update(item("K", VALUE)),
      () => w.remote.create(item("NEW", VALUE)),
      () => w.remote.delete({ key: "K", scope: ALL_SCOPES }),
    ]) {
      const e = clean(await errorOf(op()));
      expect(e.kind).toBe("failed");
      expect(e.message).toContain("immutable");
    }
    expect(w.kube.value(NS, NAME, "K")).toBe("old");
    expect(writes(w)).toEqual([]);
  });

  test("a write the server answers with an error is failed in fixed words", async () => {
    const w = world();
    await w.remote.create(item("K", "old"));
    const invalid = w.through(
      (real) => (url, init) =>
        init.method === "PATCH"
          ? Promise.resolve(Response.json({ message: LEAK, details: TOKEN }, { status: 422 }))
          : real(url, init),
    );
    const e = clean(await errorOf(invalid.update(item("K", VALUE))));
    expect(e.kind).toBe("failed");
    expect(e.message).toContain("422");
    expect(w.kube.value(NS, NAME, "K")).toBe("old");

    const odd = world();
    const bad = odd.through(
      always(() => Response.json({ message: LEAK }, { status: 200, headers: { "x-leak": LEAK } })),
    );
    clean(await errorOf(bad.create(item("K", VALUE))));
  });

  test("a Secret too large to read is failed, not cut short", async () => {
    const w = world();
    w.kube.seed(NS, NAME, { BIG: "x".repeat(900 * 1024) }, { labels: ours() });
    const e = clean(await errorOf(w.remote.read()));
    expect(e.kind).toBe("failed");
  });

  test("the token is in no error of any operation", async () => {
    const w = world();
    const wrong = w.withToken(`${TOKEN}-wrong`);
    for (const op of [
      () => wrong.read(),
      () => wrong.create(item("K", VALUE)),
      () => wrong.update(item("K", VALUE)),
      () => wrong.delete({ key: "K", scope: ALL_SCOPES }),
    ]) {
      const e = clean(await errorOf(op()));
      expect(e.message).not.toContain(`${TOKEN}-wrong`);
    }
  });
});

describe("a target of one environment", () => {
  test("a scope other than * is unsupported for every operation, before anything is asked", async () => {
    const w = world();
    for (const scope of ["production", "staging/*", "*x", " *"]) {
      expect((await errorOf(w.remote.create(item("K", VALUE, scope)))).kind).toBe("unsupported");
      expect((await errorOf(w.remote.update(item("K", VALUE, scope)))).kind).toBe("unsupported");
      expect((await errorOf(w.remote.delete({ key: "K", scope }))).kind).toBe("unsupported");
      expect(() => w.adapter.check(item("K", VALUE, scope))).toThrow(SyncError);
    }
    expect(w.kube.calls).toEqual([]);
  });

  test("a file value is unsupported", async () => {
    const w = world();
    expect((await errorOf(w.remote.create(item("K", VALUE, ALL_SCOPES, true, true)))).kind).toBe(
      "unsupported",
    );
    expect(w.kube.calls).toEqual([]);
  });
});
