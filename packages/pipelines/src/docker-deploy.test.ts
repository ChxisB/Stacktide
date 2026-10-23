import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { loadTemplates } from "./loader";
import { render } from "./render";

// DEP-9: the `docker-deploy` template. Its deploy job's script is the one place a value reaches a shell,
// so the tests run that block itself, with `sh`, against a stub `deploy.sh` and a stub `curl`.

const catalog = await loadTemplates();
const template = catalog.find((c) => c.manifest.name === "docker-deploy");
if (!template) throw new Error("no template docker-deploy");

interface Job {
  stage: string;
  image?: string;
  script: string[];
  rules: { if: string; when?: string; variables?: Record<string, string> }[];
  variables?: Record<string, string>;
  environment?: { name: string };
  resource_group?: string;
  inherit?: { default: boolean };
}
const pipeline = (params: Record<string, unknown> = {}) =>
  parse(render(template, [{ params }])) as Record<string, unknown> & {
    workflow: { rules: Job["rules"] };
    stages: string[];
    deploy: Job;
    publish: Job;
    build: Job;
  };

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await rm(dir, { recursive: true, force: true });
});

/** Runs the deploy job's script block the way a runner would: one shell, the job's variables in its environment. */
async function runJob(
  env: Record<string, string>,
  stubs: { curl?: number; deploy?: number; params?: Record<string, unknown> } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "orch-deploy-job-"));
  made.push(dir);
  const bin = join(dir, "bin");
  await mkdir(bin);
  // the script's one outside tool; with no curl in `bin` there is no curl at all
  await symlink(Bun.which("cut") ?? "/usr/bin/cut", join(bin, "cut"));
  const log = join(dir, "log");
  if (stubs.curl !== undefined) {
    await writeFile(
      join(bin, "curl"),
      `#!/bin/sh\necho "curl $*" >> "${log}"\nexit ${stubs.curl}\n`,
    );
    await chmod(join(bin, "curl"), 0o755);
  }
  const deployScript = (stubs.params?.deployScript as string | undefined) ?? "deploy.sh";
  await mkdir(join(dir, deployScript, ".."), { recursive: true });
  await writeFile(
    join(dir, deployScript),
    `#!/bin/sh\necho "deploy $ORCH_DEPLOY_ENV $ORCH_DEPLOY_SHA $IMAGE $IMAGE_TAG" >> "${log}"\nexit ${stubs.deploy ?? 0}\n`,
  );
  await chmod(join(dir, deployScript), 0o755);
  const job = pipeline(stubs.params).deploy;
  await writeFile(join(dir, "job.sh"), job.script.join("\n"));
  const p = Bun.spawn(["/bin/sh", join(dir, "job.sh")], {
    cwd: dir,
    env: {
      PATH: bin,
      CI_REGISTRY_IMAGE: "registry.example/acme/web",
      CI_COMMIT_SHA: A,
      ORCH_DEPLOY_ENV: "staging",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  const lines = await readFile(log, "utf8").then(
    (t) => t.split("\n").filter(Boolean),
    () => [] as string[],
  );
  return {
    code,
    stdout,
    stderr,
    dir,
    deploys: lines.filter((l) => l.startsWith("deploy ")),
    curls: lines.filter((l) => l.startsWith("curl ")),
  };
}

const deploy = (sha: string) =>
  `deploy staging ${sha} registry.example/acme/web:${sha.slice(0, 8)} ${sha.slice(0, 8)}`;

describe("docker-deploy: the pipeline", () => {
  test("builds as docker-image does, then deploys on the default branch", () => {
    const doc = pipeline();
    expect(doc.stages).toEqual(["build", "release", "deploy"]);
    expect(doc.build.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
    expect(doc.deploy.stage).toBe("deploy");
    expect(doc.deploy.rules.at(-1)).toEqual({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" });
  });

  test("the tag is the first 8 characters of the commit in the publish job and the deploy job alike", () => {
    const doc = pipeline();
    const text = (j: Job) => j.script.join("\n");
    expect(text(doc.publish)).toContain("cut -c1-8");
    expect(text(doc.publish)).not.toContain("CI_COMMIT_SHORT_SHA");
    expect(text(doc.deploy)).toContain("cut -c1-8");
    expect(text(doc.deploy)).not.toContain("CI_COMMIT_SHORT_SHA");
  });

  test("the first environment is the parameter's, and a promotion's variable wins over it", () => {
    const doc = pipeline({ environment: "qa" });
    // a pipeline variable (the promotion's) outranks a job's `variables:` in GitLab, so this is only the default
    expect(doc.deploy.variables).toEqual({ ORCH_DEPLOY_ENV: "qa" });
    expect(doc.deploy.environment).toEqual({ name: "$ORCH_DEPLOY_ENV" });
    expect(doc.deploy.resource_group).toBe("deploy-$ORCH_DEPLOY_ENV");
    expect(pipeline().deploy.variables).toEqual({ ORCH_DEPLOY_ENV: "staging" });
  });

  test("a promotion runs only the deploy: the publish is left out, and so is a scan", () => {
    const doc = pipeline();
    expect(doc.deploy.rules[0]).toEqual({ if: "$ORCH_DEPLOY_ENV" });
    expect(doc.publish.rules[0]).toEqual({ if: "$ORCH_DEPLOY_ENV", when: "never" });
    // a rollback does not wait for a scan of what is not being deployed
    expect(doc.workflow.rules[0]).toEqual({
      if: "$ORCH_DEPLOY_ENV",
      variables: { SECRET_DETECTION_DISABLED: "true" },
    });
  });

  test("the deploy runs in the image the parameter names and takes nothing from `default`", () => {
    expect(pipeline().deploy.image).toBe("docker:27");
    expect(pipeline({ deployImage: "alpine/helm:3.15" }).deploy.image).toBe("alpine/helm:3.15");
    expect(pipeline().deploy.inherit).toEqual({ default: false });
  });

  test("the script the repository ships is the one that runs", () => {
    const text = pipeline({ deployScript: "ops/deploy.sh" }).deploy.script.join("\n");
    expect(text).toContain('"./ops/deploy.sh"');
    expect(pipeline().deploy.script.join("\n")).toContain('"./deploy.sh"');
  });

  test("is not recommended: it is chosen, so a Docker project is still offered docker-image", () => {
    expect(template.manifest.detects).toEqual([]);
  });

  test.each([
    ["environment", ["Staging", "a b", "a--b", "-a", "a-", "", "a".repeat(64)]],
    ["deployScript", ["../deploy.sh", "/deploy.sh", "-x", "a b", "a;b", ""]],
    ["deployImage", ["a b", "../x", "a/../b", "-x", "A:b", "a:b c", "a;b"]],
  ])("%s refuses what is not one", (param, bad) => {
    for (const value of bad as string[])
      expect(
        () => render(template, [{ params: { [param]: value } }]),
        `${param}=${value}`,
      ).toThrow();
  });

  test.each([
    ["environment", ["staging", "prod-eu-1", "a"]],
    ["deployScript", ["deploy.sh", "ops/deploy.sh", "scripts/deploy_v2.sh"]],
    ["deployImage", ["docker:27", "alpine/helm:3.15", "registry.example/team/tool:1.2.3-rc.1"]],
  ])("%s takes what is one", (param, good) => {
    for (const value of good as string[])
      expect(
        () => render(template, [{ params: { [param]: value } }]),
        `${param}=${value}`,
      ).not.toThrow();
  });
});

describe("docker-deploy: the deploy job's script, run", () => {
  test("a pipeline of the default branch deploys its own commit, with the image and the tag", async () => {
    const r = await runJob({});
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.deploys).toEqual([deploy(A)]);
    expect(r.curls).toEqual([]); // no ORCH_HEALTH_URL: no check
  });

  test("a promotion deploys the sha it names", async () => {
    const r = await runJob({
      ORCH_DEPLOY_ENV: "staging",
      ORCH_DEPLOY_SHA: B,
      ORCH_PREVIOUS_SHA: C,
    });
    expect(r.code).toBe(0);
    expect(r.deploys).toEqual([deploy(B)]);
  });

  test("a healthy check passes: the script runs once and the URL is asked, with retries", async () => {
    const r = await runJob({ ORCH_HEALTH_URL: "https://staging.example/health" }, { curl: 0 });
    expect(r.code).toBe(0);
    expect(r.deploys).toEqual([deploy(A)]);
    expect(r.curls).toHaveLength(1);
    expect(r.curls[0]).toContain("--fail");
    expect(r.curls[0]).toContain("--retry");
    expect(r.curls[0]).toContain("https://staging.example/health");
  });

  test("a failed check with a previous build puts that back, and the job still fails", async () => {
    const r = await runJob(
      {
        ORCH_DEPLOY_SHA: B,
        ORCH_PREVIOUS_SHA: C,
        ORCH_HEALTH_URL: "https://staging.example/health",
      },
      { curl: 22 },
    );
    expect(r.code).toBe(1);
    expect(r.deploys).toEqual([deploy(B), deploy(C)]);
    expect(r.curls).toHaveLength(1); // the build put back is not checked: there is nothing earlier to go to
    expect(r.stderr).toContain("staging");
  });

  test("a failed check with no previous build fails the job and runs the script once", async () => {
    const r = await runJob(
      { ORCH_DEPLOY_SHA: B, ORCH_HEALTH_URL: "https://staging.example/health" },
      { curl: 22 },
    );
    expect(r.code).toBe(1);
    expect(r.deploys).toEqual([deploy(B)]);
  });

  test("a script that fails fails the job and nothing is put back", async () => {
    const r = await runJob(
      {
        ORCH_DEPLOY_SHA: B,
        ORCH_PREVIOUS_SHA: C,
        ORCH_HEALTH_URL: "https://staging.example/health",
      },
      { deploy: 3, curl: 0 },
    );
    expect(r.code).not.toBe(0);
    expect(r.deploys).toEqual([deploy(B)]);
    expect(r.curls).toEqual([]);
  });

  test("a health URL with no curl to check it stops before anything is deployed", async () => {
    const r = await runJob({ ORCH_HEALTH_URL: "https://staging.example/health" });
    expect(r.code).toBe(1);
    expect(r.deploys).toEqual([]);
    expect(r.stderr).toContain("curl");
  });

  test("the script named by the parameter runs", async () => {
    const r = await runJob({}, { params: { deployScript: "ops/deploy.sh" } });
    expect(r.code).toBe(0);
    expect(r.deploys).toEqual([deploy(A)]);
  });

  const shell = [
    "a;b",
    "$(touch pwned)",
    "`touch pwned`",
    `${A}\n${A}`,
    "a b",
    "'",
    '"',
    "&&",
    "|",
    ">x",
  ];

  test.each([
    [
      "ORCH_DEPLOY_SHA",
      ["abc", "a".repeat(39), "a".repeat(41), "A".repeat(40), `${"a".repeat(39)};`, ...shell],
    ],
    ["ORCH_PREVIOUS_SHA", ["abc", "a".repeat(39), "a".repeat(41), "A".repeat(40), ...shell]],
    ["ORCH_DEPLOY_ENV", ["", "Staging", "-x", "x-", "a--b", "a".repeat(64), ...shell]],
  ])("a bad %s stops before the script, and nothing in it is run", async (name, bad) => {
    for (const value of bad as string[]) {
      const r = await runJob({
        [name as string]: value,
        ORCH_DEPLOY_SHA: name === "ORCH_DEPLOY_SHA" ? value : B,
      });
      expect([name, value, r.code === 0, r.deploys]).toEqual([name, value, false, []]);
      expect(r.stderr).toContain("docker-deploy:");
      expect(await Bun.file(join(r.dir, "pwned")).exists()).toBe(false);
    }
  });
});

describe("the deployments doc (DEP-10)", () => {
  const read = (path: string) => Bun.file(new URL(`../../../${path}`, import.meta.url)).text();
  const names = (text: string, pattern: RegExp) => [...new Set(text.match(pattern) ?? [])].sort();

  test("names the variables the template's script uses, and no other", async () => {
    const doc = await read("docs/deployments.md");
    // the names the script reads or hands on: what the template says is what the page must say
    const used = names(render(template), /\b(?:ORCH_[A-Z0-9_]+|IMAGE_TAG|IMAGE)\b/g);
    const said = [
      ...new Set([...doc.matchAll(/`(ORCH_[A-Z0-9_]+|IMAGE_TAG|IMAGE)`/g)].map((m) => m[1] ?? "")),
    ].sort();
    expect(used).toEqual([
      "IMAGE",
      "IMAGE_TAG",
      "ORCH_DEPLOY_ENV",
      "ORCH_DEPLOY_SHA",
      "ORCH_HEALTH_URL",
      "ORCH_PREVIOUS_SHA",
    ]);
    expect(said).toEqual(used);
  });

  test("shows the parameters the manifest has", async () => {
    const doc = await read("docs/deployments.md");
    for (const name of Object.keys(template.manifest.params.properties))
      expect(doc, name).toContain(`\`${name}\``);
  });

  test("the README links it, and its webhook sentence names the Deployment events", async () => {
    const readme = await read("README.md");
    expect(readme).toContain("(docs/deployments.md)");
    expect(await Bun.file(new URL("../../../docs/deployments.md", import.meta.url)).exists()).toBe(
      true,
    );
    const webhooks = readme.split("\n").find((l) => l.startsWith("Webhooks:")) ?? "";
    expect(webhooks).toContain("deployment");
  });
});
