import { describe, expect, test } from "bun:test";
import { detectProjectTypes, IAC_TAGS } from "./project-types";

const tags = (paths: string[]) => detectProjectTypes(paths).map((t) => `${t.tag}:${t.confidence}`);

describe("detectProjectTypes", () => {
  test("a Bun repo", () => {
    expect(tags(["package.json", "bun.lock", "src/index.ts", "README.md"])).toEqual(["bun:high"]);
    expect(tags(["package.json", "bun.lockb"])).toEqual(["bun:high"]);
    expect(tags(["bunfig.toml", "src/a.ts"])).toEqual(["bun:high"]);
  });

  test("a Node repo: a lockfile makes it sure, a bare package.json less so", () => {
    expect(tags(["package.json", "package-lock.json"])).toEqual(["node:high"]);
    expect(tags(["package.json", "yarn.lock"])).toEqual(["node:high"]);
    expect(tags(["package.json", "pnpm-lock.yaml"])).toEqual(["node:high"]);
    expect(tags(["package.json", "index.js"])).toEqual(["node:medium"]);
  });

  test("a Docker repo", () => {
    expect(tags(["Dockerfile", "main.go"])).toEqual(["docker:high"]);
    expect(tags(["Dockerfile.prod"])).toEqual(["docker:high"]);
    expect(tags(["api.Dockerfile"])).toEqual(["docker:high"]);
    expect(tags(["Containerfile"])).toEqual(["docker:high"]);
    expect(tags(["docker-compose.yml"])).toEqual(["docker:high"]);
    expect(tags(["compose.yaml"])).toEqual(["docker:high"]);
    expect(tags(["services/api/Dockerfile"])).toEqual(["docker:medium"]);
  });

  test("a Terraform repo", () => {
    expect(tags(["main.tf", "variables.tf"])).toEqual(["terraform:high"]);
    expect(tags([".terraform.lock.hcl"])).toEqual(["terraform:high"]);
    expect(tags(["main.tf.json"])).toEqual(["terraform:high"]);
    expect(tags(["infra/prod/main.tf"])).toEqual(["terraform:medium"]);
    expect(tags(["terragrunt.hcl", "env/prod/terragrunt.hcl"])).toEqual(["terragrunt:high"]);
    expect(tags(["live/prod/terragrunt.hcl"])).toEqual(["terragrunt:medium"]);
  });

  test("a DNSControl repo: a dnsconfig.js is a zone's config, and it is planned like infrastructure (DNS-12)", () => {
    expect(tags(["dnsconfig.js", "creds.json", "stack.yml"])).toEqual(["dnscontrol:high"]);
    expect(tags(["zones/example/dnsconfig.js"])).toEqual(["dnscontrol:medium"]);
    // a repo of zones next to code is both
    expect(tags(["main.tf", "dns/dnsconfig.js"])).toEqual(["terraform:high", "dnscontrol:medium"]);
    expect(IAC_TAGS).toContain("dnscontrol");
  });

  test("a mixed repo gets every tag, in a fixed order, the strongest evidence deciding", () => {
    const found = detectProjectTypes([
      "infra/main.tf",
      "infra/network/main.tf",
      "terragrunt.hcl",
      "Dockerfile",
      "package.json",
      "bun.lock",
      "web/package.json",
      "web/package-lock.json",
    ]);
    expect(found.map((t) => `${t.tag}:${t.confidence}`)).toEqual([
      "bun:high",
      "node:medium", // web/ is a Node package, but not at the root
      "docker:high",
      "terraform:medium",
      "terragrunt:high",
    ]);
    expect(found.find((t) => t.tag === "terraform")?.evidence).toEqual([
      "infra/main.tf",
      "infra/network/main.tf",
    ]);
  });

  test("a package.json beside a Bun lockfile is the Bun project, not a Node one", () => {
    expect(tags(["package.json", "bun.lock", "package-lock.json"])).toEqual(["bun:high"]);
    expect(tags(["a/package.json", "a/bun.lock", "b/package.json"])).toEqual([
      "bun:medium",
      "node:medium",
    ]);
  });

  test("a repo with none of these has no tags", () => {
    expect(detectProjectTypes([])).toEqual([]);
    expect(tags(["README.md", "src/main.go", "docs/Dockerfile.md"])).toEqual([]);
  });

  test("vendored and generated directories do not count", () => {
    expect(
      tags(["node_modules/x/package.json", "vendor/y/main.tf", ".terraform/modules/main.tf"]),
    ).toEqual([]);
    expect(tags(["a/node_modules/b/Dockerfile", ".git/Dockerfile"])).toEqual([]);
  });

  test("evidence is capped, sorted and does not repeat", () => {
    const paths = ["z.tf", "a.tf", "m.tf", "b.tf", "a.tf"];
    expect(detectProjectTypes(paths)[0]?.evidence).toEqual(["a.tf", "b.tf", "m.tf"]);
  });

  test("names are matched exactly, case included", () => {
    expect(
      tags(["dockerfile", "MAIN.TF", "Package.json", "BUN.LOCK", "DNSCONFIG.JS", "dnsconfig.json"]),
    ).toEqual([]);
    expect(tags(["my-dnsconfig.js", "dnsconfig.js.md", "dnsconfig.js/readme"])).toEqual([]);
  });
});
