import { describe, expect, test } from "bun:test";
import { detectProjectTypes } from "@orch/core";
import { loadTemplates, type Template } from "./loader";
import { newest, recommend, secretDetectionWarnings } from "./recommend";

const catalog = await loadTemplates();
const of = (...paths: string[]) => recommend(detectProjectTypes(paths), catalog);
const summary = (r: ReturnType<typeof of>) =>
  r.map((x) => `${x.template}@${x.version} ${x.confidence}`);

/** A copy of a catalog template under another version or tags. */
const variant = (
  name: string,
  change: { version?: string; detects?: Template["manifest"]["detects"] },
) => {
  const t = catalog.find((c) => c.manifest.name === name);
  if (!t) throw new Error(`no template ${name}`);
  return { ...t, manifest: { ...t.manifest, ...change } };
};

describe("recommend", () => {
  test("a Bun project gets bun-app, with the file that says so", () => {
    const r = of("package.json", "bun.lock", "src/index.ts");
    expect(summary(r)).toEqual(["bun-app@1.0.0 high"]);
    expect(r[0]?.reason).toBe("bun (bun.lock)");
  });

  test("a Node project gets node-app: high with a lockfile, medium without", () => {
    expect(summary(of("package.json", "package-lock.json"))).toEqual(["node-app@1.0.0 high"]);
    expect(summary(of("package.json"))).toEqual(["node-app@1.0.0 medium"]);
  });

  test("a Docker-only project gets docker-image", () => {
    expect(summary(of("Dockerfile", "README.md"))).toEqual(["docker-image@1.0.0 high"]);
  });

  test("a Terraform project and an empty one get nothing: no template suits them", () => {
    expect(of("main.tf", "variables.tf")).toEqual([]);
    expect(of()).toEqual([]);
  });

  test("a project of two kinds gets both, the surer one first", () => {
    expect(summary(of("bun.lock", "Dockerfile"))).toEqual([
      "bun-app@1.0.0 high",
      "docker-image@1.0.0 high",
    ]);
    // alphabetical order would put bun-app first: confidence beats it
    expect(summary(of("services/api/bun.lock", "Dockerfile"))).toEqual([
      "docker-image@1.0.0 high",
      "bun-app@1.0.0 medium",
    ]);
  });

  test("only the newest version of a template is recommended, newest by number", () => {
    const old = [
      variant("bun-app", { version: "1.2.0" }),
      variant("bun-app", { version: "1.10.0" }),
      variant("bun-app", { version: "1.9.0" }),
    ];
    expect(summary(recommend(detectProjectTypes(["bun.lock"]), old))).toEqual([
      "bun-app@1.10.0 high",
    ]);
  });

  test("the order of the catalog does not matter", () => {
    const detected = detectProjectTypes(["bun.lock", "Dockerfile"]);
    expect(recommend(detected, [...catalog].reverse())).toEqual(recommend(detected, catalog));
  });

  test("a template for two kinds is recommended once, for the surest, and says why for both", () => {
    const both = [variant("bun-app", { detects: ["bun", "docker"] })];
    const r = recommend(detectProjectTypes(["apps/x/bun.lock", "Dockerfile"]), both);
    expect(r).toHaveLength(1);
    expect(r[0]?.confidence).toBe("high");
    expect(r[0]?.reason).toBe("bun (apps/x/bun.lock); docker (Dockerfile)");
  });

  test("a template that suits no kind is never recommended", () => {
    expect(
      recommend(detectProjectTypes(["bun.lock"]), [variant("bun-app", { detects: [] })]),
    ).toEqual([]);
  });
});

describe("newest", () => {
  test("one version of each template, the newest, in the order of the names", () => {
    const named = (name: string, version: string) => ({
      ...variant("bun-app", { version }),
      manifest: { ...variant("bun-app", { version }).manifest, name },
    });
    const found = newest([
      named("zed", "1.0.0"),
      named("alpha", "1.0.0"),
      named("alpha", "1.10.0"),
      named("alpha", "1.9.0"),
      named("mid", "2.0.0"),
    ]);
    expect(found.map((m) => `${m.name}@${m.version}`)).toEqual([
      "alpha@1.10.0",
      "mid@2.0.0",
      "zed@1.0.0",
    ]);
  });
});

describe("secretDetectionWarnings (SCAN-5)", () => {
  test("with the scan off there is nothing to say, whatever the runners are", () => {
    expect(secretDetectionWarnings({ secretDetection: false, executors: ["shell"] })).toEqual([]);
    expect(secretDetectionWarnings({ secretDetection: false })).toEqual([]);
  });

  test("runners that are not known are a warning that says so, not a failure", () => {
    const [w, ...more] = secretDetectionWarnings({ secretDetection: true });
    expect(more).toEqual([]);
    expect(w).toContain("not known");
    expect(w).toContain("docker");
  });

  test.each([["docker"], ["docker+machine"], ["docker-autoscaler"], ["kubernetes"]])(
    "a %s runner can run it",
    (executor) => {
      expect(
        secretDetectionWarnings({ secretDetection: true, executors: ["shell", executor] }),
      ).toEqual([]);
    },
  );

  test("runners that are known and none of them runs containers: a warning that names what they are", () => {
    const [w, ...more] = secretDetectionWarnings({
      secretDetection: true,
      executors: ["shell", "ssh", "shell"],
    });
    expect(more).toEqual([]);
    expect(w).toContain("shell, ssh");
  });

  test("a project with no runner at all is the same warning: nothing can run it", () => {
    expect(secretDetectionWarnings({ secretDetection: true, executors: [] })).toHaveLength(1);
  });
});
