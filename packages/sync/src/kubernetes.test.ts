import { describe, expect, test } from "bun:test";
import type { Fetch } from "./http";
import {
  checkKubernetes,
  KUBE_VERBS,
  kubernetesConfigSchema,
  kubernetesTokenSchema,
} from "./kubernetes";

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.CANARY-service-account-token.signature0123456789";
const config = { server: "https://k8s.example.test:6443", namespaces: ["apps", "staging"] };
const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  tls: unknown;
  body: { spec: { resourceAttributes: Record<string, string> } };
}

/** The API server as far as the check uses it: SelfSubjectAccessReview, answered from a table of what the token may do. */
function fakeApi(
  may: (ns: string, verb: string) => boolean,
  opts: { status?: number; token?: string } = {},
) {
  const seen: Seen[] = [];
  const fetch: Fetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = JSON.parse(String(init.body));
    seen.push({ url, method: String(init.method), headers, tls: init.tls, body });
    if (opts.status) return new Response(`{"message":"leak ${TOKEN}"}`, { status: opts.status });
    if (headers.authorization !== `Bearer ${opts.token ?? TOKEN}`) {
      return new Response("{}", { status: 401 });
    }
    const { namespace, verb } = body.spec.resourceAttributes;
    return Response.json(
      { status: { allowed: may(namespace ?? "", verb ?? "") } },
      { status: 201 },
    );
  };
  return { fetch, seen };
}

describe("checkKubernetes", () => {
  test("asks the API server, per namespace and verb, whether the token may handle Secrets", async () => {
    const api = fakeApi(() => true);
    const r = await checkKubernetes(config, TOKEN, { fetch: api.fetch });
    expect(r).toEqual({ ok: true, summary: "Secrets can be read and written in: apps, staging" });
    expect(api.seen).toHaveLength(2 * KUBE_VERBS.length);
    for (const s of api.seen) {
      expect(s.method).toBe("POST");
      expect(s.url).toBe(
        "https://k8s.example.test:6443/apis/authorization.k8s.io/v1/selfsubjectaccessreviews",
      );
      expect(s.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(s.body.spec.resourceAttributes.resource).toBe("secrets");
    }
    expect(
      api.seen
        .map(
          (s) =>
            `${s.body.spec.resourceAttributes.namespace}:${s.body.spec.resourceAttributes.verb}`,
        )
        .sort(),
    ).toEqual(["apps", "staging"].flatMap((ns) => KUBE_VERBS.map((v) => `${ns}:${v}`)).sort());
  });

  test("a namespace the token may not write in is `forbidden`, named with the verbs it lacks", async () => {
    const api = fakeApi(
      (ns, verb) => !(ns === "staging" && (verb === "create" || verb === "patch")),
    );
    const r = await checkKubernetes(config, TOKEN, { fetch: api.fetch });
    expect(r).toMatchObject({ ok: false, reason: "forbidden" });
    expect(r).toMatchObject({
      message: expect.stringContaining("namespace staging: create, patch"),
    });
    expect(JSON.stringify(r)).not.toContain("apps:");
  });

  test("a token the server does not know is `unauthorized`, whatever the server said", async () => {
    const api = fakeApi(() => true, { token: "another" });
    const r = await checkKubernetes(config, TOKEN, { fetch: api.fetch });
    expect(r).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  test("each other failure is fixed words and never the server's text or the token", async () => {
    for (const [status, reason] of [
      [403, "forbidden"],
      [404, "not_found"],
      [429, "rate_limited"],
      [500, "server"],
      [400, "invalid"],
    ] as const) {
      const r = await checkKubernetes(config, TOKEN, {
        fetch: fakeApi(() => true, { status }).fetch,
      });
      expect([status, r]).toMatchObject([status, { ok: false, reason }]);
      expect(JSON.stringify(r)).not.toContain("CANARY");
      expect(JSON.stringify(r)).not.toContain("k8s.example.test");
    }
  });

  test("an answer that does not say `allowed: true` is a no", async () => {
    const f: Fetch = async () => Response.json({ status: {} }, { status: 201 });
    expect(await checkKubernetes(config, TOKEN, { fetch: f })).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    const junk: Fetch = async () => new Response("<html>", { status: 201 });
    expect(await checkKubernetes(config, TOKEN, { fetch: junk })).toMatchObject({
      ok: false,
      reason: "unexpected",
    });
  });

  test("an unreachable server is `network`", async () => {
    const down: Fetch = async () => {
      throw new Error(`connect failed ${TOKEN}`);
    };
    const r = await checkKubernetes(config, TOKEN, { fetch: down });
    expect(r).toMatchObject({ ok: false, reason: "network" });
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });

  test("a private CA is trusted for this connection only", async () => {
    const api = fakeApi(() => true);
    await checkKubernetes({ ...config, ca: CA }, TOKEN, { fetch: api.fetch });
    expect(api.seen.every((s) => (s.tls as { ca: string }).ca === CA)).toBe(true);
    const plain = fakeApi(() => true);
    await checkKubernetes(config, TOKEN, { fetch: plain.fetch });
    expect(plain.seen.every((s) => s.tls === undefined)).toBe(true);
  });
});

describe("what a connection is allowed to say", () => {
  test("an https server and 1-20 namespaces, named", () => {
    expect(kubernetesConfigSchema.parse(config)).toEqual(config);
    expect(kubernetesConfigSchema.parse({ ...config, ca: CA }).ca).toBe(CA);
    const bad = [
      { ...config, server: "http://k8s.example.test" },
      { ...config, server: "https://user:hunter2@k8s.example.test" },
      { ...config, server: "https://k8s.example.test/path?x=1" },
      { ...config, server: "not a url" },
      { ...config, namespaces: [] },
      { ...config, namespaces: ["Apps"] },
      { ...config, namespaces: ["a_b"] },
      { ...config, namespaces: ["*"] },
      { ...config, namespaces: ["apps", "apps"] },
      { ...config, namespaces: Array.from({ length: 21 }, (_, i) => `ns${i}`) },
      { ...config, ca: "not a certificate" },
      { ...config, ca: `${CA}${"x".repeat(20000)}` },
      { ...config, token: TOKEN },
      { namespaces: config.namespaces },
    ];
    for (const b of bad) {
      expect([b, kubernetesConfigSchema.safeParse(b).success]).toEqual([b, false]);
    }
  });

  test("the server is kept as its origin", () => {
    expect(
      kubernetesConfigSchema.parse({ ...config, server: "https://k8s.example.test:6443/" }).server,
    ).toBe("https://k8s.example.test:6443");
  });

  test("a token is one printable word of a sane length", () => {
    expect(kubernetesTokenSchema.safeParse(TOKEN).success).toBe(true);
    for (const bad of [
      "",
      "short",
      "has space in it 0123456789",
      "x".repeat(8193),
      "tab\there0123456789012",
    ]) {
      expect(kubernetesTokenSchema.safeParse(bad).success).toBe(false);
    }
  });
});
