import { describe, expect, test } from "bun:test";
import { parseAllDocuments } from "yaml";
import { loadTemplates } from "./loader";
import { GENERATED, RenderError, render, renderComponent, renderInclude } from "./render";

const templates = await loadTemplates();
const bun = templates.find((t) => t.manifest.name === "bun-app");
if (!bun) throw new Error("bun-app is not shipped");
const into = { project: "grp/ci-templates", version: "1.2.3" };
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

describe("the component mode", () => {
  test("includes the component of the catalog project at the version, with the parameters as inputs", () => {
    const text = renderComponent(bun, [{ params: { bunVersion: "1.2" } }], into);
    expect(
      text.startsWith(`${GENERATED} bun-app@1.0.0, component of grp/ci-templates@1.2.3.`),
    ).toBe(true);
    const [doc] = docs(text) as [{ include: Record<string, unknown>[] }];
    expect(doc.include).toHaveLength(1);
    expect(doc.include[0]).toMatchObject({
      component: "$CI_SERVER_FQDN/grp/ci-templates/bun-app@1.2.3",
      inputs: { bunVersion: "1.2" },
    });
    expect(Object.keys(doc)).toEqual(["include"]);
  });

  test("takes the same inputs as the include mode, and is the same every time", () => {
    const layers = [{ params: { bunVersion: "1.2", testScript: "t" } }];
    const inc = docs(renderInclude(bun, layers, { project: into.project })) as {
      include: { inputs: unknown }[];
    }[];
    const comp = docs(renderComponent(bun, layers, into)) as { include: { inputs: unknown }[] }[];
    expect(comp[0]?.include[0]?.inputs).toEqual(inc[0]?.include[0]?.inputs);
    expect(renderComponent(bun, layers, into)).toBe(renderComponent(bun, layers, into));
    expect(renderComponent(bun, layers, into)).not.toBe(render(bun, layers));
  });

  test.each(["1", "1.2", "1.2.3", "0.0.1", "9f".repeat(20)])(
    "accepts the version %s",
    (version) => {
      const text = renderComponent(bun, [], { ...into, version });
      expect(text).toContain(`bun-app@${version}\n`);
    },
  );

  test.each([
    "~latest",
    "main",
    "master",
    "v1.2.3",
    "1.2.3.4",
    "1.2.3-rc.1",
    "latest",
    "",
    "1.2.3\nx: y",
    "abc1234",
    "../1.2.3",
    "1.2.3 ",
  ])("refuses the version %p: a branch or a moving ref can change a merged pipeline", (version) => {
    expect(problemsOf(() => renderComponent(bun, [], { ...into, version }))).toEqual([
      "component version: must be a release such as 1.2.3 (or 1, 1.2) or a full commit SHA, not a branch or ~latest",
    ]);
  });

  test("refuses a project that is not a project path, an override of the include, and bad parameters", () => {
    expect(problemsOf(() => renderComponent(bun, [], { ...into, project: "../x" }))[0]).toContain(
      "include project",
    );
    expect(
      problemsOf(() => renderComponent(bun, [{ overrides: { include: [] } }], into))[0],
    ).toContain("include is the template's own");
    expect(problemsOf(() => renderComponent(bun, [{ params: { nope: 1 } }], into))[0]).toContain(
      "nope",
    );
  });

  test("reports every problem at once", () => {
    expect(
      problemsOf(() =>
        renderComponent(bun, [{ overrides: { include: [] } }], { project: "x", version: "main" }),
      ),
    ).toHaveLength(3);
  });
});
