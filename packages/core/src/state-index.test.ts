import { describe, expect, test } from "bun:test";
import { MAX_INDEXED_RESOURCES, parseStateResources } from "./state-index";

const CANARY = "tf-attr-SECRET-CANARY-4417";
const AWS = 'provider["registry.terraform.io/hashicorp/aws"]';
const resource = (over: Record<string, unknown> = {}) => ({
  mode: "managed",
  type: "aws_s3_bucket",
  name: "logs",
  provider: AWS,
  instances: [{ schema_version: 0, attributes: { id: "b" } }],
  ...over,
});
const ok = (resources: unknown) => {
  const r = parseStateResources({ version: 4, resources });
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.resources;
};
const refused = (state: unknown) => {
  const r = parseStateResources(state);
  if (r.ok) throw new Error("accepted");
  return r.reason;
};

describe("parseStateResources: what identifies a resource instance", () => {
  test("a resource of the root module, a data source, and a module's, with their addresses", () => {
    expect(
      ok([
        resource(),
        resource({ mode: "data", type: "aws_caller_identity", name: "me" }),
        resource({ module: "module.net", type: "aws_vpc", name: "main" }),
      ]),
    ).toEqual([
      {
        address: "aws_s3_bucket.logs",
        mode: "managed",
        type: "aws_s3_bucket",
        name: "logs",
        provider: "registry.terraform.io/hashicorp/aws",
        module: null,
        indexKey: null,
      },
      {
        address: "data.aws_caller_identity.me",
        mode: "data",
        type: "aws_caller_identity",
        name: "me",
        provider: "registry.terraform.io/hashicorp/aws",
        module: null,
        indexKey: null,
      },
      {
        address: "module.net.aws_vpc.main",
        mode: "managed",
        type: "aws_vpc",
        name: "main",
        provider: "registry.terraform.io/hashicorp/aws",
        module: "module.net",
        indexKey: null,
      },
    ]);
  });

  test("a count index and a for_each key are one instance each, in the address", () => {
    const got = ok([
      resource({ module: 'module.a["x"]', instances: [{ index_key: 0 }, { index_key: 1 }] }),
      resource({ name: "named", instances: [{ index_key: "eu" }, { index_key: 'a"b' }] }),
    ]);
    expect(got.map((r) => r.address)).toEqual([
      'module.a["x"].aws_s3_bucket.logs[0]',
      'module.a["x"].aws_s3_bucket.logs[1]',
      'aws_s3_bucket.named["eu"]',
      'aws_s3_bucket.named["a\\"b"]',
    ]);
    expect(got.map((r) => r.indexKey)).toEqual(["0", "1", "eu", 'a"b']);
  });

  test("a provider is its source address, an alias or not; one that is not written that way stays as written", () => {
    const got = ok([
      resource({ provider: `${AWS}.west` }),
      resource({ name: "b", provider: "provider.aws" }),
    ]);
    expect(got.map((r) => r.provider)).toEqual([
      "registry.terraform.io/hashicorp/aws",
      "provider.aws",
    ]);
  });

  test("a state with no resources, or none written, has an empty index", () => {
    expect(ok([])).toEqual([]);
    expect(parseStateResources({ version: 4 })).toEqual({ ok: true, resources: [] });
    expect(ok([resource({ instances: [] })])).toEqual([]);
  });

  test("attributes, sensitive attributes, private data, dependencies and outputs are never read", () => {
    const state = {
      version: 4,
      outputs: { token: { value: CANARY, sensitive: true } },
      resources: [
        resource({
          instances: [
            {
              index_key: "k",
              attributes: { password: CANARY, nested: { secret: CANARY } },
              sensitive_attributes: [[{ type: "get_attr", value: CANARY }]],
              private: CANARY,
              dependencies: [CANARY],
            },
          ],
        }),
      ],
    };
    const got = parseStateResources(state);
    expect(got.ok).toBe(true);
    expect(JSON.stringify(got)).not.toContain(CANARY);
  });
});

describe("parseStateResources: what is refused", () => {
  const bad: [string, unknown][] = [
    ["not an object", [CANARY]],
    ["not version 4", { version: 3, resources: [] }],
    ["resources not a list", { version: 4, resources: { [CANARY]: 1 } }],
    ["a resource that is not an object", { version: 4, resources: [CANARY] }],
    ["a mode that is neither", { version: 4, resources: [resource({ mode: "other" })] }],
    ["no type", { version: 4, resources: [resource({ type: undefined })] }],
    ["an empty name", { version: 4, resources: [resource({ name: "" })] }],
    ["a provider that is not text", { version: 4, resources: [resource({ provider: 5 })] }],
    ["a module that is not text", { version: 4, resources: [resource({ module: 5 })] }],
    ["instances that are not a list", { version: 4, resources: [resource({ instances: {} })] }],
    [
      "an instance that is not an object",
      { version: 4, resources: [resource({ instances: [1] })] },
    ],
    [
      "an index that is a boolean",
      { version: 4, resources: [resource({ instances: [{ index_key: true }] })] },
    ],
    [
      "an index that is a fraction",
      { version: 4, resources: [resource({ instances: [{ index_key: 1.5 }] })] },
    ],
    [
      "a name over the field cap",
      { version: 4, resources: [resource({ name: "n".repeat(1025) })] },
    ],
    [
      "a name with a NUL, which Postgres cannot keep",
      { version: 4, resources: [resource({ name: "n\u0000" })] },
    ],
    ["a module with a NUL", { version: 4, resources: [resource({ module: "module.\u0000" })] }],
    [
      "an index key with a NUL",
      { version: 4, resources: [resource({ instances: [{ index_key: "k\u0000" }] })] },
    ],
    ["the same instance twice", { version: 4, resources: [resource(), resource()] }],
  ];
  for (const [what, state] of bad) {
    test(what, () => {
      expect(typeof refused(state)).toBe("string");
    });
  }

  test("a reason never holds a value from the state", () => {
    for (const [, state] of bad) expect(refused(state)).not.toContain(CANARY);
  });

  test("more instances than the cap are refused, and exactly the cap is not", () => {
    const some = (n: number) => [
      resource({ instances: Array.from({ length: n }, (_, i) => ({ index_key: i })) }),
    ];
    expect(parseStateResources({ version: 4, resources: some(MAX_INDEXED_RESOURCES) }).ok).toBe(
      true,
    );
    expect(typeof refused({ version: 4, resources: some(MAX_INDEXED_RESOURCES + 1) })).toBe(
      "string",
    );
  });
});
