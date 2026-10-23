import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { loadTemplates } from "./loader";
import { render, SECRET_DETECTION_TEMPLATE } from "./render";

const catalog = await loadTemplates();
const names = catalog.map((t) => `${t.manifest.name}@${t.manifest.version}`);

/** What a project would be handed with no parameters given. */
const rendered = (name: string) => {
  const t = catalog.find((c) => c.manifest.name === name);
  if (!t) throw new Error(`no template ${name}`);
  return { t, text: render(t) };
};

describe("the starter templates", () => {
  test("are the four the catalog starts with, all sound", () => {
    expect(names).toEqual([
      "bun-app@1.0.0",
      "docker-deploy@1.0.0",
      "docker-image@1.0.0",
      "node-app@1.0.0",
    ]);
  });

  test.each([
    ["bun-app", ["bun"]],
    ["node-app", ["node"]],
    ["docker-image", ["docker"]],
    // chosen, not recommended: a Docker project is still offered docker-image
    ["docker-deploy", []],
  ])("%s suits %j projects", (name, tags) => {
    expect<string[]>(rendered(name).t.manifest.detects).toEqual(tags);
  });

  test.each(names.map((n) => n.split("@")[0] ?? ""))("%s renders with its defaults", (name) => {
    expect(rendered(name).text).toMatchSnapshot();
  });

  test.each(names.map((n) => n.split("@")[0] ?? ""))(
    "%s is a pipeline whose jobs all run in a stage it declares",
    (name) => {
      const doc = parse(rendered(name).text) as Record<string, Record<string, unknown>>;
      const stages = doc.stages as unknown as string[];
      const jobs = Object.entries(doc).filter(
        ([k]) => !["workflow", "default", "stages", "variables"].includes(k),
      );
      expect(jobs.length).toBeGreaterThan(0);
      for (const [job, def] of jobs) expect(stages, job).toContain(def.stage as string);
    },
  );

  test("a given parameter reaches the pipeline", () => {
    const bun = catalog.find((c) => c.manifest.name === "bun-app");
    if (!bun) throw new Error("no bun-app");
    const text = render(bun, [
      { params: { bunVersion: "1.2", buildOutput: "out/", testScript: "test:unit" } },
    ]);
    expect(text).toContain("image: oven/bun:1.2");
    expect(text).toContain("bun run test:unit");
    expect(text).toContain("- out/");
  });

  describe("no string parameter takes anything a shell would act on", () => {
    const nasty = [
      "a b",
      "a;b",
      "a&&b",
      "a|b",
      "$(id)",
      "`id`",
      ["$", "{HOME}"].join(""),
      "a>b",
      "a<b",
      "a'b",
      'a"b',
      "a\nb",
      "a\\b",
      "../x",
      "/etc/passwd",
      "-x",
      "--help",
      "~",
      "*",
      "",
    ];
    const cases = catalog.flatMap((t) =>
      Object.entries(t.manifest.params.properties)
        .filter(([, p]) => p.type === "string" && p.enum === undefined)
        .map(([param]) => [t.manifest.name, param] as const),
    );

    test("there are some to check", () => {
      expect(cases.length).toBeGreaterThanOrEqual(10);
    });

    test.each(cases)("%s.%s", (name, param) => {
      const t = catalog.find((c) => c.manifest.name === name);
      if (!t) throw new Error(`no template ${name}`);
      const taken = nasty.filter((value) => {
        try {
          render(t, [{ params: { [param]: value } }]);
          return true;
        } catch {
          return false;
        }
      });
      expect(taken).toEqual([]);
    });
  });
});

describe("the starter templates with secret detection on (SCAN-5)", () => {
  const starters = names.map((n) => n.split("@")[0] ?? "");
  const on = (name: string) => {
    const t = catalog.find((c) => c.manifest.name === name);
    if (!t) throw new Error(`no template ${name}`);
    return render(t, [{ params: { secretDetection: true } }]);
  };

  test.each(starters)("%s renders with GitLab's template and its job", (name) => {
    expect(on(name)).toMatchSnapshot();
  });

  test.each(starters)("%s: off is what it always rendered, byte for byte", (name) => {
    const t = catalog.find((c) => c.manifest.name === name);
    if (!t) throw new Error(`no template ${name}`);
    expect(render(t, [{ params: { secretDetection: false } }])).toBe(render(t));
    expect(render(t)).not.toContain("secret_detection");
  });

  test.each(starters)(
    "%s: the job is in a stage the pipeline declares and takes nothing from `default`",
    (name) => {
      const doc = parse(on(name)) as Record<string, Record<string, unknown>>;
      expect(doc.include).toEqual([{ template: SECRET_DETECTION_TEMPLATE }] as never);
      // the starters name their stages and none has GitLab's own `test`
      expect(doc.stages as unknown as string[]).toContain(doc.secret_detection?.stage as string);
      // `default` holds each starter's image, services and install step: none of it is for the analyzer's image
      expect(doc.secret_detection?.inherit).toEqual({ default: false });
    },
  );
});
