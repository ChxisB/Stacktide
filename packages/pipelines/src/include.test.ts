import { describe, expect, test } from "bun:test";
import { parseAllDocuments } from "yaml";
import { SAMPLE_PARAMS } from "./cloud-samples";
import { loadTemplates, type Template } from "./loader";
import { manifestSchema } from "./manifest";
import {
  GENERATED,
  type IncludeTarget,
  includeFile,
  includePath,
  type Layer,
  RenderError,
  render,
  renderInclude,
} from "./render";

const ANY = "^[\\s\\S]*$";
const tpl = (
  pipeline: string,
  properties: Record<string, Record<string, unknown>> = {},
  required: string[] = [],
): Template => ({
  manifest: manifestSchema.parse({
    name: "demo",
    version: "1.2.3",
    description: "demo",
    params: { type: "object", properties, required },
  }),
  pipeline,
});
const docs = (text: string) => parseAllDocuments(text, { version: "1.2" }).map((d) => d.toJS());
const problemsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RenderError);
    return (e as RenderError).problems;
  }
  throw new Error("did not throw");
};
const target: IncludeTarget = { project: "grp/ci-templates", ref: "main" };

const CI = `build:
  image: "{{ params.image }}"
  retry: "{{ params.retries }}"
  allow_failure: "{{ params.lenient }}"
  script:
    - echo "building on {{ params.image }} and {{ params.image }}"
`;
const PARAMS = {
  image: { type: "string", default: "node:22", description: "The image.", pattern: ANY },
  retries: { type: "integer", default: 2 },
  lenient: { type: "boolean", default: false },
  stage: { type: "string", enum: ["a", "b"] },
};
const withStage = `${CI}  stage: "{{ params.stage }}"\n`;
const demo = () => tpl(withStage, PARAMS, ["stage"]);

/**
 * What GitLab does with an included file and the `inputs` it is given, written out again: defaults
 * fill what is missing, a block that is a whole value keeps the input's type, one inside text is text.
 */
function interpolate(file: string, given: Record<string, unknown>) {
  const [head, body] = docs(file) as [
    { spec: { inputs: Record<string, { default?: unknown }> } },
    unknown,
  ];
  const values: Record<string, unknown> = {};
  for (const [name, input] of Object.entries(head.spec.inputs)) {
    values[name] = Object.hasOwn(given, name) ? given[name] : input.default;
    if (values[name] === undefined) throw new Error(`${name} is required`);
  }
  for (const name of Object.keys(given))
    if (!(name in values)) throw new Error(`${name} is not an input`);
  const BLOCK = /\$\[\[ inputs\.([A-Za-z0-9_]+) \]\]/g;
  const walk = (n: unknown): unknown => {
    if (typeof n === "string") {
      const whole = /^\$\[\[ inputs\.([A-Za-z0-9_]+) \]\]$/.exec(n);
      if (whole) return values[whole[1] ?? ""];
      return n.replace(BLOCK, (_, name: string) => String(values[name]));
    }
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === "object")
      return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, walk(v)]));
    return n;
  };
  return walk(body);
}
const inputsOf = (thin: string) =>
  (docs(thin)[0] as { include: { inputs?: Record<string, unknown> }[] }).include[0]?.inputs ?? {};

describe("includeFile", () => {
  test("is a spec of the manifest's parameters, then the template's pipeline", () => {
    const [head, body] = docs(includeFile(demo())) as [
      { spec: { inputs: Record<string, unknown> } },
      Record<string, unknown>,
    ];
    expect(head).toEqual({
      spec: {
        inputs: {
          image: { type: "string", description: "The image.", default: "node:22" },
          retries: { type: "number", default: 2 },
          lenient: { type: "boolean", default: false },
          stage: { type: "string", options: ["a", "b"] },
        },
      },
    });
    expect(body).toEqual({
      build: {
        image: "$[[ inputs.image ]]",
        retry: "$[[ inputs.retries ]]",
        allow_failure: "$[[ inputs.lenient ]]",
        script: ['echo "building on $[[ inputs.image ]] and $[[ inputs.image ]]"'],
        stage: "$[[ inputs.stage ]]",
      },
    });
  });

  test("says in its first line which template it is", () => {
    expect(includeFile(demo()).split("\n")[0]).toStartWith("# demo@1.2.3 from orch's catalog");
  });

  test("a number parameter is a number input", () => {
    const t = tpl('a:\n  script: ["{{ params.ratio }}"]\n', {
      ratio: { type: "number", default: 0.5 },
    });
    expect(docs(includeFile(t))[0]).toEqual({
      spec: { inputs: { ratio: { type: "number", default: 0.5 } } },
    });
  });

  test("leaves patterns out: GitLab's regex is RE2, which has no lookahead", () => {
    const t = tpl('a:\n  script: ["{{ params.x }}"]\n', {
      x: { type: "string", pattern: "^(?![/-])[a-z]+$" },
    });
    expect(includeFile(t)).not.toContain("regex");
    expect(includeFile(t)).not.toContain("(?!");
  });

  test("a template without parameters has an empty spec", () => {
    expect(docs(includeFile(tpl("a:\n  script: [x]\n")))[0]).toEqual({ spec: { inputs: {} } });
  });

  test("a pipeline that cannot be read is refused", () => {
    expect(problemsOf(() => includeFile(tpl("a: [unclosed\n")))[0]).toStartWith("pipeline.yml:");
  });

  test("is where the thin file says it is", () => {
    expect(includePath({ name: "bun-app", version: "1.0.0" })).toBe("bun-app/1.0.0/pipeline.yml");
    const thin = renderInclude(demo(), [{ params: { stage: "a" } }], target);
    expect((docs(thin)[0] as { include: { file: string }[] }).include[0]?.file).toBe(
      includePath(demo().manifest),
    );
  });
});

describe("renderInclude", () => {
  test("includes the template's file from the templates project with every parameter as an input", () => {
    const thin = renderInclude(demo(), [{ params: { stage: "b", retries: 5 } }], target);
    expect(thin.startsWith(GENERATED)).toBe(true);
    expect(thin.split("\n")[0]).toContain("demo@1.2.3");
    expect(thin.split("\n")[0]).toContain("grp/ci-templates");
    expect(docs(thin)).toEqual([
      {
        include: [
          {
            project: "grp/ci-templates",
            ref: "main",
            file: "demo/1.2.3/pipeline.yml",
            inputs: { image: "node:22", retries: 5, lenient: false, stage: "b" },
          },
        ],
      },
    ]);
  });

  test("names no ref when none is given, and no inputs when the template has none", () => {
    const thin = renderInclude(tpl("a:\n  script: [x]\n"), [], { project: "grp/ci-templates" });
    expect(docs(thin)).toEqual([
      { include: [{ project: "grp/ci-templates", file: "demo/1.2.3/pipeline.yml" }] },
    ]);
  });

  test("the same inputs give the same text, in the manifest's order", () => {
    const a = renderInclude(demo(), [{ params: { stage: "a", retries: 3 } }], target);
    const b = renderInclude(demo(), [{ params: { retries: 3, stage: "a" } }], target);
    expect(a).toBe(b);
    expect(Object.keys(inputsOf(a))).toEqual(["image", "retries", "lenient", "stage"]);
  });

  test("layers are resolved as render does: a later layer wins, defaults fill the rest", () => {
    const layers: Layer[] = [{ params: { stage: "a", retries: 1 } }, { params: { retries: 9 } }];
    expect(inputsOf(renderInclude(demo(), layers, target))).toEqual({
      image: "node:22",
      retries: 9,
      lenient: false,
      stage: "a",
    });
  });

  test("overrides are merged over the thin file, so GitLab merges them over the included jobs", () => {
    const thin = renderInclude(
      demo(),
      [{ params: { stage: "a" }, overrides: { build: { tags: ["big"] }, variables: { X: "1" } } }],
      target,
    );
    const [doc] = docs(thin) as [Record<string, unknown>];
    expect(doc.build).toEqual({ tags: ["big"] });
    expect(doc.variables).toEqual({ X: "1" });
    expect(Object.keys(doc)).toEqual(["include", "build", "variables"]);
  });

  test("an override cannot replace the include", () => {
    expect(
      problemsOf(() =>
        renderInclude(demo(), [{ params: { stage: "a" }, overrides: { include: [] } }], target),
      ),
    ).toEqual(["overrides: include is the template's own in include mode"]);
  });

  test("parameters are checked as render checks them", () => {
    expect(problemsOf(() => renderInclude(demo(), [], target)).join("\n")).toContain("stage");
    expect(
      problemsOf(() => renderInclude(demo(), [{ params: { stage: "c" } }], target)).join("\n"),
    ).toContain("stage");
    expect(
      problemsOf(() => renderInclude(demo(), [{ params: { stage: "a", nope: 1 } }], target)).join(
        "\n",
      ),
    ).toContain("nope");
  });

  test.each([
    "grp",
    "",
    "grp/",
    "/grp/x",
    "grp//x",
    "grp/../x",
    "grp/./x",
    "grp/x y",
    "grp/x\ny",
    "grp/x:y",
    `${"a".repeat(130)}/${"b".repeat(130)}`,
  ])("the templates project %j is refused", (project) => {
    const problems = problemsOf(() =>
      renderInclude(demo(), [{ params: { stage: "a" } }], { project }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("include project:");
  });

  test.each(["", "-x", "a..b", "a b", "a\nb", "a".repeat(101), "x:y"])(
    "the ref %j is refused",
    (ref) => {
      const problems = problemsOf(() =>
        renderInclude(demo(), [{ params: { stage: "a" } }], { project: "grp/x", ref }),
      );
      expect(problems).toEqual(["include ref: must be a branch or tag name"]);
    },
  );

  test.each(["main", "v1.2.3", "release/2026-10", "feature_x"])("the ref %j is accepted", (ref) => {
    expect(() =>
      renderInclude(demo(), [{ params: { stage: "a" } }], { project: "grp/sub.group/x-y", ref }),
    ).not.toThrow();
  });

  test("a value stays a value, whatever it looks like", () => {
    const hostile = "a: b\n- c # d\n---\n$[[ inputs.stage ]] {{ params.stage }}";
    const t = tpl("a:\n  script: [x]\n", { x: { type: "string", pattern: ANY } });
    const thin = renderInclude(t, [{ params: { x: hostile } }], target);
    expect(docs(thin)).toHaveLength(1);
    expect(inputsOf(thin)).toEqual({ x: hostile });
  });
});

describe("both modes", () => {
  const sets: Record<string, Layer[]> = {
    defaults: [{ params: { stage: "a" } }],
    given: [{ params: { stage: "b", image: "node:20 (lts)", retries: 0, lenient: true } }],
  };

  for (const [name, layers] of Object.entries(sets)) {
    test(`include mode and inline mode describe the same pipeline (${name})`, () => {
      const t = demo();
      const inline = docs(render(t, layers))[0];
      const thin = renderInclude(t, layers, target);
      expect(interpolate(includeFile(t), inputsOf(thin))).toEqual(inline);
    });
  }

  test("an input that the template does not declare is not accepted by the included file", () => {
    expect(() => interpolate(includeFile(demo()), { stage: "a", extra: 1 })).toThrow(
      "not an input",
    );
    expect(() => interpolate(includeFile(demo()), {})).toThrow("stage is required");
  });

  test("every template the platform ships does too", async () => {
    const catalog = await loadTemplates();
    expect(catalog.length).toBeGreaterThan(0);
    for (const t of catalog) {
      const required = Object.fromEntries(
        t.manifest.params.required.map((k) => {
          const p = t.manifest.params.properties[k];
          return [k, SAMPLE_PARAMS[t.manifest.name]?.[k] ?? p?.enum?.[0] ?? "x"];
        }),
      );
      const layers: Layer[] = [{ params: required }];
      const inline = docs(render(t, layers))[0];
      const thin = renderInclude(t, layers, target);
      expect(interpolate(includeFile(t), inputsOf(thin))).toEqual(inline);
    }
  });
});
