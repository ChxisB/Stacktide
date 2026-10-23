import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { loadTemplates, type Template, TemplateError } from "./loader";
import { manifestSchema } from "./manifest";
import { GENERATED, RenderError, render, renderWorkflow } from "./render";

// FRG-16: the same templates as a GitHub Actions workflow.

const catalog = await loadTemplates();
const find = (name: string) => {
  const t = catalog.find((c) => c.manifest.name === name);
  if (!t) throw new Error(`no template ${name}`);
  return t;
};
const withWorkflow = catalog.filter((t) => t.workflow !== undefined);
const names = withWorkflow.map((t) => t.manifest.name);

/** An Actions expression, written so the linter does not take it for a template string. */
const expr = (e: string) => `\${{ ${e} }}`;

const problemsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RenderError);
    return (e as RenderError).problems;
  }
  throw new Error("did not throw");
};

describe("the shipped workflows", () => {
  test("are those of the templates that run on any runner; docker-deploy has none yet", () => {
    expect(names).toEqual(["bun-app", "docker-image", "node-app"]);
    expect(find("docker-deploy").workflow).toBeUndefined();
  });

  test.each(names)("%s renders with its defaults", (name) => {
    expect(renderWorkflow(find(name))).toMatchSnapshot();
  });

  test.each(names)(
    "%s begins as a file of ours does, so a re-run can tell it from a hand-written one",
    (name) => {
      expect(renderWorkflow(find(name)).startsWith(GENERATED)).toBe(true);
    },
  );

  test.each(names)(
    "%s reads the repository and nothing more, and asks for no token to the platform",
    (name) => {
      const doc = parse(renderWorkflow(find(name)), { version: "1.1" }) as {
        permissions: Record<string, string>;
        jobs: Record<string, { permissions?: Record<string, string> }>;
      };
      expect(doc.permissions).toEqual({ contents: "read" });
      // no job of these templates calls the platform, so none may mint an OIDC token for it
      const granted = [doc.permissions, ...Object.values(doc.jobs).map((j) => j.permissions)];
      expect(JSON.stringify(granted)).not.toContain("id-token");
    },
  );

  test.each(names)("%s: every action it uses is pinned to a commit", (name) => {
    const uses = [...renderWorkflow(find(name)).matchAll(/uses: (\S+)/g)].map((m) => m[1] ?? "");
    for (const u of uses) expect(u, u).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  });

  test("a parameter reaches the workflow, and a placeholder is the only thing filled", () => {
    const text = renderWorkflow(find("bun-app"), [
      { params: { bunVersion: "1.2", buildOutput: "out/", testScript: "test:unit" } },
    ]);
    expect(text).toContain("oven/bun:1.2");
    expect(text).toContain("bun run test:unit");
    expect(text).toContain("path: out/");
    expect(renderWorkflow(find("docker-image"))).toContain(expr("secrets.GITHUB_TOKEN"));
  });

  test("the jobs are those of the GitLab pipeline", () => {
    const gitlab = parse(render(find("bun-app"))) as Record<string, unknown>;
    const reserved = ["workflow", "default", "stages", "variables"];
    const jobs = Object.keys(gitlab).filter((k) => !reserved.includes(k));
    const doc = parse(renderWorkflow(find("bun-app")), { version: "1.1" }) as {
      jobs: Record<string, unknown>;
    };
    expect(Object.keys(doc.jobs)).toEqual(jobs);
  });

  test("a value cannot become a step: a hostile parameter is refused as it is for GitLab", () => {
    const e = problemsOf(() =>
      renderWorkflow(find("bun-app"), [{ params: { testScript: "x\n      - run: curl evil" } }]),
    );
    expect(e.join()).toContain("testScript");
  });

  test("nor can a value open an Actions expression and read a secret", () => {
    for (const v of [expr("secrets.GITHUB_TOKEN"), "$GITHUB_TOKEN", "`id`"]) {
      const e = problemsOf(() => renderWorkflow(find("bun-app"), [{ params: { testScript: v } }]));
      expect(e.join()).toContain("testScript");
    }
  });
});

describe("what a workflow cannot be", () => {
  test("a template with no workflow says so, naming it", () => {
    const e = problemsOf(() => renderWorkflow(find("docker-deploy")));
    expect(e).toEqual(["docker-deploy@1.0.0 has no GitHub Actions form yet"]);
  });

  test.each([
    ["include", [{ project: "g/p", file: "x.yml" }]],
    ["stages", ["a"]],
    ["default", { image: "x" }],
    ["image", "x"],
    ["variables", { A: "b" }],
  ])("an override with the GitLab key %s is refused, by name", (key, value) => {
    const e = problemsOf(() =>
      renderWorkflow(find("bun-app"), [{ overrides: { [key]: value } as never }]),
    );
    expect(e).toHaveLength(1);
    expect(e[0]).toContain(`\`${key}\``);
    expect(e[0]).toContain("GitLab");
  });

  test("GitHub's own keys are accepted in an override and merged over the workflow", () => {
    const text = renderWorkflow(find("bun-app"), [
      { overrides: { env: { CI: "true" }, concurrency: { group: "orch" } } },
    ]);
    const doc = parse(text, { version: "1.1" }) as Record<string, unknown>;
    expect(doc.env).toEqual({ CI: "true" });
    expect(doc.concurrency).toEqual({ group: "orch" });
  });

  test("a value one YAML reader would take for a number is refused, as it is for a pipeline, and not echoed", () => {
    const manifest = manifestSchema.parse({
      name: "demo",
      version: "1.0.0",
      description: "demo",
      params: {
        type: "object",
        properties: { v: { type: "string", pattern: "^[a-z0-9]+$" } },
        required: ["v"],
      },
    });
    const template: Template = {
      manifest,
      pipeline: 'a:\n  script:\n    - "{{ params.v }}"\n',
      workflow:
        'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - name: "{{ params.v }}"\n',
    };
    expect(renderWorkflow(template, [{ params: { v: "fine" } }])).toContain("name: fine");
    expect(problemsOf(() => renderWorkflow(template, [{ params: { v: "0o17" } }]))).toEqual([
      "a value cannot be written so that every YAML reader sees the same",
    ]);
  });

  test("secret detection is GitLab's analyzer and is refused, not dropped", () => {
    const e = problemsOf(() =>
      renderWorkflow(find("bun-app"), [{ params: { secretDetection: true } }]),
    );
    expect(e.join()).toContain("secretDetection");
  });
});

describe("the loader reads workflow.yml", () => {
  const dirs: string[] = [];
  const load = async (workflow: string) => {
    const root = await mkdtemp(join(tmpdir(), "orch-workflows-"));
    dirs.push(root);
    const at = (f: string) => join(root, "demo", "1.0.0", f);
    await mkdir(dirname(at("x")), { recursive: true });
    const m = manifestSchema.parse({
      name: "demo",
      version: "1.0.0",
      description: "demo",
      params: {
        type: "object",
        properties: { script: { type: "string", default: "test", pattern: "^[a-z]+$" } },
        required: [],
      },
    });
    await writeFile(at("manifest.json"), JSON.stringify(m));
    await writeFile(at("pipeline.yml"), 'test:\n  script:\n    - "bun run {{ params.script }}"\n');
    await writeFile(at("workflow.yml"), workflow);
    const err = await loadTemplates(root).then(
      (t) => t,
      (e: unknown) => e,
    );
    await rm(root, { recursive: true, force: true });
    return err;
  };
  const good =
    'on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: "bun run {{ params.script }}"\n';

  test("a sound one is kept with the template", async () => {
    const found = await load(good);
    expect(Array.isArray(found) && found[0]?.workflow).toBe(good);
  });

  test("one with a GitLab key, an undeclared parameter, or no jobs is refused, each by name", async () => {
    for (const [bad, why] of [
      [`${good}stages: [a]\n`, "stages"],
      [good.replace("params.script", "params.nope"), "nope"],
      ["on: push\n", "jobs"],
    ] as const) {
      const err = await load(bad);
      expect(err).toBeInstanceOf(TemplateError);
      expect((err as TemplateError).problems.join("\n")).toMatch(
        new RegExp(`demo/1.0.0: workflow.yml: .*${why}`),
      );
    }
  });
});

/** Opt in with the path of a release binary: `ACTIONLINT_BIN=<path> bun test packages/pipelines/src/workflow.test.ts`. */
const actionlint = process.env.ACTIONLINT_BIN;
describe.skipIf(!actionlint)("actionlint (opt in with ACTIONLINT_BIN)", () => {
  test.each(names)("%s passes", async (name) => {
    const dir = await mkdtemp(join(tmpdir(), "orch-actionlint-"));
    try {
      const file = join(dir, "orch.yml");
      await writeFile(file, renderWorkflow(find(name)));
      const run = Bun.spawnSync([actionlint as string, "-no-color", file]);
      expect(run.stdout.toString() + run.stderr.toString()).toBe("");
      expect(run.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("and finds what is wrong, so a pass means something", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orch-actionlint-"));
    try {
      const file = join(dir, "orch.yml");
      await writeFile(
        file,
        `on: push\njobs:\n  a:\n    steps:\n      - run: "${expr("nope.x")}"\n`,
      );
      expect(Bun.spawnSync([actionlint as string, "-no-color", file]).exitCode).not.toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
