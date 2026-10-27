import { afterAll, describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { SAMPLE_PARAMS } from "./cloud-samples";
import { cleanUp, runScript, stub } from "./deploy-harness";
import { deployRunName } from "./deploy-run";
import { loadTemplates } from "./loader";
import { render, renderWorkflow } from "./render";

// CLD-7, CLD-8, CLD-9: the `cloud-run` and `ecs` templates, on GitLab and on GitHub. Each is a thin wrapper round the
// shipped script: the tests hold the copy to the file, the variables to a closed list, the GitHub permissions to the
// one job that needs a token, and run the template's own script block with stub CLIs.

const catalog = await loadTemplates();
const find = (name: string) => {
  const t = catalog.find((c) => c.manifest.name === name);
  if (!t) throw new Error(`no template ${name}`);
  return t;
};
const scriptOf = async (file: string) =>
  (await Bun.file(new URL(`../scripts/${file}`, import.meta.url)).text()).replace(
    /^#!\/bin\/sh\n/,
    "",
  );
afterAll(cleanUp);

/** An Actions expression, written so the linter does not take it for a template string. */
const expr = (e: string) => `\${{ ${e} }}`;

const A = "a".repeat(40);
const COMMON = [
  "ORCH_CONTEXT",
  "ORCH_DEPLOY_ENV",
  "ORCH_DEPLOY_SHA",
  "ORCH_DOCKERFILE",
  "ORCH_OIDC_TOKEN",
];
const CLOUDS = [
  {
    name: "cloud-run",
    file: "deploy-cloud-run.sh",
    audience: `https://iam.googleapis.com/${SAMPLE_PARAMS["cloud-run"]?.provider}`,
    allowed: [
      ...COMMON,
      "ORCH_CLOUD_PROJECT",
      "ORCH_CLOUD_PROVIDER",
      "ORCH_CLOUD_REGION",
      "ORCH_CLOUD_REPOSITORY",
      "ORCH_CLOUD_SERVICE",
      "ORCH_CLOUD_SERVICE_ACCOUNT",
    ],
  },
  {
    name: "ecs",
    file: "deploy-ecs.sh",
    audience: "sts.amazonaws.com",
    allowed: [
      ...COMMON,
      "ORCH_CLOUD_ACCOUNT",
      "ORCH_CLOUD_CLUSTER",
      "ORCH_CLOUD_REGION",
      "ORCH_CLOUD_REPOSITORY",
      "ORCH_CLOUD_ROLE",
      "ORCH_CLOUD_SERVICE",
      "ORCH_SERVICE_URL",
    ],
  },
];

const layers = (name: string, params: Record<string, unknown> = {}) => [
  { params: { ...SAMPLE_PARAMS[name], ...params } },
];

interface Job {
  stage: string;
  image: string;
  services: string[];
  script: string[];
  rules: { if: string }[];
  variables: Record<string, string>;
  environment: { name: string };
  resource_group: string;
  inherit: { default: boolean };
  id_tokens: Record<string, { aud: string }>;
}
const gitlab = (name: string, params?: Record<string, unknown>) =>
  parse(render(find(name), layers(name, params))) as {
    workflow: { rules: { if: string; variables?: Record<string, string> }[] };
    stages: string[];
    deploy: Job;
  };

interface Workflow {
  "run-name": string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      if: string;
      environment: string;
      permissions: Record<string, string>;
      steps: {
        uses?: string;
        with?: Record<string, string | boolean>;
        env?: Record<string, string>;
        run?: string;
      }[];
    }
  >;
}
const github = (name: string, params?: Record<string, unknown>) =>
  parse(renderWorkflow(find(name), layers(name, params)), { version: "1.1" }) as Workflow;

describe.each(CLOUDS)("$name on GitLab", ({ name, file, audience, allowed }) => {
  test("the job holds the shipped script, whole", async () => {
    expect(gitlab(name).deploy.script).toEqual([`${(await scriptOf(file)).trimEnd()}\n`]);
  });

  test("the pipeline names no variable outside the script's closed list, and no secret", () => {
    const text = render(find(name), layers(name));
    const used = new Set(text.match(/\bORCH_[A-Z_]+\b/g));
    expect([...used].filter((v) => !allowed.includes(v))).toEqual([]);
    expect(text).not.toMatch(/CI_JOB_TOKEN|CI_REGISTRY_PASSWORD|CI_DEPLOY_PASSWORD/);
    // the only value taken from the pipeline's own variables is the commit
    const taken = Object.entries(gitlab(name).deploy.variables).filter(([, v]) => v.includes("$"));
    expect(taken).toEqual([["ORCH_DEPLOY_SHA", "$CI_COMMIT_SHA"]]);
  });

  test("the job asks GitLab for an identity token for the cloud and for nothing else", () => {
    const { deploy } = gitlab(name);
    expect(deploy.id_tokens).toEqual({ ORCH_OIDC_TOKEN: { aud: audience } });
  });

  test("the environment is the platform's slug, one deploy at a time, and nothing is inherited", () => {
    const { deploy } = gitlab(name);
    expect(deploy.environment).toEqual({ name: "$ORCH_DEPLOY_ENV" });
    expect(deploy.resource_group).toBe("deploy-$ORCH_DEPLOY_ENV");
    expect(deploy.inherit).toEqual({ default: false });
    expect(deploy.variables.ORCH_DEPLOY_ENV).toBe("staging");
    expect(gitlab(name, { environment: "production" }).deploy.variables.ORCH_DEPLOY_ENV).toBe(
      "production",
    );
    expect(deploy.variables.ORCH_DEPLOY_SHA).toBe("$CI_COMMIT_SHA");
  });

  test("it runs on the default branch and for a deploy the platform starts, never for a merge request", () => {
    const { deploy, workflow } = gitlab(name);
    expect(deploy.rules.map((r) => r.if)).toEqual([
      "$ORCH_DEPLOY_ENV",
      "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH",
    ]);
    expect(workflow.rules.map((r) => r.if)).toEqual([
      "$ORCH_DEPLOY_ENV",
      "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH",
    ]);
    // a promotion is one deploy: no scan of the branch's head stands in its way (as in docker-deploy)
    expect(workflow.rules[0]?.variables).toEqual({ SECRET_DETECTION_DISABLED: "true" });
  });

  test("the job runs in a stage the pipeline declares", () => {
    const { deploy, stages } = gitlab(name);
    expect(stages).toContain(deploy.stage);
  });
});

describe.each(CLOUDS)("$name on GitHub", ({ name, file, audience, allowed }) => {
  test("the step holds the shipped script, whole, after the token request", async () => {
    const run = github(name).jobs.deploy?.steps.at(-1)?.run ?? "";
    const marker = "export ORCH_OIDC_TOKEN\n";
    expect(run.slice(run.indexOf(marker) + marker.length)).toBe(
      `${(await scriptOf(file)).trimEnd()}\n`,
    );
  });

  test("no secret, no pull_request_target, no trigger but a push and a hand start", () => {
    const text = renderWorkflow(find(name), layers(name));
    expect(text).not.toMatch(/\bsecrets\./);
    expect(text).not.toContain("pull_request");
    expect(Object.keys(github(name).on).sort()).toEqual(["push", "workflow_dispatch"]);
  });

  test("it reads the repository, and only the deploy job may ask for an identity token", () => {
    const doc = github(name);
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(Object.keys(doc.jobs)).toEqual(["deploy"]);
    expect(doc.jobs.deploy?.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("the job names the environment, from the hand start's input or the parameter", () => {
    const doc = github(name, { environment: "production" });
    const job = doc.jobs.deploy;
    expect(job?.environment).toBe(expr("inputs.environment || 'production'"));
    expect(doc.concurrency).toEqual({
      group: `deploy-${expr("inputs.environment || 'production'")}`,
      "cancel-in-progress": false,
    });
    expect(job?.if).toContain("workflow_dispatch");
  });

  test("a hand start names its run as the platform will look for it, and a push gets a name no hand start can have", () => {
    const title = github(name)["run-name"];
    // the environment's slug has no parenthesis, so `(push)` is never an environment
    expect(title).toBe(
      `orch deploy ${expr("inputs.environment || '(push)'")} ${expr("inputs.sha || github.sha")}`,
    );
    const handStart = title
      .replace(expr("inputs.environment || '(push)'"), "production")
      .replace(expr("inputs.sha || github.sha"), A);
    expect(handStart).toBe(deployRunName("production", A));
  });

  test("a hand start's inputs reach the script through the environment, never through the shell text", () => {
    const steps = github(name).jobs.deploy?.steps ?? [];
    const run = steps.at(-1);
    expect(run?.env?.ORCH_DEPLOY_ENV).toBe(expr("inputs.environment || 'staging'"));
    expect(run?.env?.ORCH_DEPLOY_SHA).toBe(expr("inputs.sha || github.sha"));
    for (const s of steps) expect(s.run ?? "").not.toMatch(/\$\{\{/);
  });

  test("the checkout is pinned and keeps no credential; the token is asked for the cloud's audience", () => {
    const steps = github(name).jobs.deploy?.steps ?? [];
    expect(steps[0]?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(steps[0]?.with?.["persist-credentials"]).toBe(false);
    expect(steps.at(-1)?.run).toContain(`"audience=${audience}"`);
  });

  test("the step names no variable outside the script's closed list", () => {
    const names = new Set(renderWorkflow(find(name), layers(name)).match(/\bORCH_[A-Z_]+\b/g));
    expect([...names].filter((v) => !allowed.includes(v))).toEqual([]);
  });
});

describe("the parameters", () => {
  test.each(CLOUDS.map((c) => c.name))(
    "%s refuses a value for a field the cloud would not accept",
    (name) => {
      const bad: Record<string, string[]> = {
        environment: ["Production", "a_b", "-x", ""],
        region: ["", "eu west", "x"],
        service: ["Web", "-web", "web service"],
        repository: ["Web", "../x"],
        deployImage: ["a b", "../x", ""],
      };
      for (const [param, values] of Object.entries(bad))
        for (const value of values)
          expect(
            () => render(find(name), layers(name, { [param]: value })),
            `${param}=${value}`,
          ).toThrow();
    },
  );

  test("the cloud-run provider and service account must be the ones the blueprint writes", () => {
    for (const value of ["projects/1/locations/global/workloadIdentityPools/p", "x", "//iam/x"])
      expect(() => render(find("cloud-run"), layers("cloud-run", { provider: value }))).toThrow();
    for (const value of ["a@b.com", "x", "web-deploy@acme-staging-123.iam.gserviceaccount.com;id"])
      expect(() =>
        render(find("cloud-run"), layers("cloud-run", { serviceAccount: value })),
      ).toThrow();
  });

  test("the ecs account is twelve digits and the role is a name, not an ARN", () => {
    for (const value of ["1234", "12345678901a", "arn:aws:iam::1:role/x"])
      expect(() => render(find("ecs"), layers("ecs", { account: value }))).toThrow();
    for (const value of ["arn:aws:iam::123456789012:role/x", "a b", "-x"])
      expect(() => render(find("ecs"), layers("ecs", { role: value }))).toThrow();
  });

  test.each(CLOUDS.map((c) => c.name))("%s asks for what it cannot default", (name) => {
    expect(() => render(find(name))).toThrow(/param \w+/);
    expect(() => renderWorkflow(find(name))).toThrow(/param \w+/);
  });
});

// The template's own script block, run the way a runner would, behaves as the file does.
const normal = (line: string) => line.replace(/orch-deploy(?:-script-|\.)\w+/g, "W");
const gcloud = stub(
  "gcloud",
  `case "$1 $2" in
  "run services") case "$3" in describe) echo https://web.a.run.app ;; esac ;;
esac`,
);
const docker = stub("docker");
const aws = stub(
  "aws",
  `case "$1 $2" in
  "ecr describe-images") echo sha256:abc ;;
  "ecs describe-services") echo arn:aws:ecs:eu-west-2:123456789012:task-definition/staging-web-service:7 ;;
  "ecs describe-task-definition")
    case "$*" in
      *"length("*) echo 0 ;;
      *) echo '{"family":"f","containerDefinitions":[{"name":"app","image":"x:1"}]}' ;;
    esac ;;
  "ecs register-task-definition") echo arn:aws:ecs:eu-west-2:123456789012:task-definition/staging-web-service:8 ;;
esac`,
);
const curl = stub("curl", `echo '{"count":1,"value":"stub-oidc-token"}'`);
const stubsOf = (name: string) => ({
  ...(name === "ecs" ? { aws } : { gcloud }),
  docker,
  curl,
});

describe.each(CLOUDS)("$name: the template's script block", ({ name, file }) => {
  test("run on GitLab with the job's variables, it does what the script file does", async () => {
    const { deploy } = gitlab(name);
    const env = {
      ...Object.fromEntries(
        Object.entries(deploy.variables).map(([k, v]) => [k, v === "$CI_COMMIT_SHA" ? A : v]),
      ),
      ORCH_OIDC_TOKEN: "stub-oidc-token",
    };
    const fromTemplate = await runScript(deploy.script.join("\n"), { env, stubs: stubsOf(name) });
    const fromFile = await runScript(await scriptOf(file), { env, stubs: stubsOf(name) });
    expect(fromTemplate.stderr).toBe("");
    expect(fromTemplate.code).toBe(0);
    expect(fromTemplate.log.length).toBeGreaterThan(3);
    expect(fromTemplate.log.map(normal)).toEqual(fromFile.log.map(normal));
    // every name the script validates is one the job sets
    expect(Object.keys(deploy.variables)).toContain("ORCH_DEPLOY_SHA");
  });

  test("run on GitHub, the step asks for a token for the cloud and then does the same", async () => {
    const doc = github(name);
    const step = doc.jobs.deploy?.steps.at(-1);
    const env = {
      ...Object.fromEntries(
        Object.entries(step?.env ?? {}).map(([k, v]) => [
          k,
          v
            .replace(expr("inputs.sha || github.sha"), A)
            .replace(/\$\{\{ inputs\.environment \|\| '(.*)' \}\}/, "$1"),
        ]),
      ),
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.example.com/?api=1",
    };
    const r = await runScript(step?.run ?? "", { env, stubs: stubsOf(name) });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.log[0]).toMatch(/^curl --fail --silent --show-error -G --data-urlencode audience=/);
    expect(r.log.slice(1).length).toBeGreaterThan(3);
    // the identity token never reaches the log or the output
    expect(r.log.join("\n") + r.stdout).not.toContain("stub-oidc-token");
  });

  test("and a failing token request stops it before any cloud tool runs", async () => {
    const step = github(name).jobs.deploy?.steps.at(-1);
    const r = await runScript(step?.run ?? "", {
      env: { STUB_FAIL: "curl:--fail" },
      stubs: stubsOf(name),
    });
    expect(r.code).not.toBe(0);
    expect(r.log.filter((l) => !l.startsWith("curl"))).toEqual([]);
  });
});
