import { describe, expect, test } from "bun:test";
import { createGitlab } from "@orch/gitlab";
import { createMockGitlab } from "@orch/gitlab/mock";
import { loadTemplates, render } from "@orch/pipelines";

// DEP-9: the mock GitLab's lint accepts what `docker-deploy` renders, with its parameters and with secret detection on.
// The mock models a few CI rules only: `environment:name: $VAR`, `resource_group` and `rules` are for a real GitLab (ADR-0020).

const catalog = await loadTemplates();
const template = catalog.find((t) => t.manifest.name === "docker-deploy");
if (!template) throw new Error("no template docker-deploy");

function lint(content: string) {
  const mock = createMockGitlab();
  mock.addProject({ path: "g/web" });
  return createGitlab({
    baseUrl: mock.url,
    auth: { type: "private-token", token: mock.token },
    maxRetries: 0,
  }).ci.lint("g/web", content);
}

describe("docker-deploy against the mock's lint", () => {
  test.each([
    ["its defaults", {}],
    [
      "every parameter given",
      {
        environment: "qa",
        deployScript: "ops/deploy.sh",
        deployImage: "alpine/helm:3.15",
        dockerfile: "build/Dockerfile",
        context: "app",
        dockerVersion: "26.1",
      },
    ],
    ["secret detection on", { secretDetection: true }],
  ])("accepts %s", async (_, params) => {
    const r = await lint(render(template, [{ params }]));
    expect(r).toMatchObject({ valid: true, errors: [] });
  });

  test("a deploy job in a stage that is not declared is refused (the lint is looking at it)", async () => {
    const r = await lint(render(template, [{ overrides: { deploy: { stage: "nowhere" } } }]));
    expect(r.valid).toBe(false);
    expect(r.errors.join(" ")).toContain("jobs:deploy");
  });
});
