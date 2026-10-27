import { afterAll, describe, expect, test } from "bun:test";
import { cleanUp, runScript, stub } from "./deploy-harness";

// CLD-5 and CLD-6: the shipped deploy scripts, run with `sh` against stub CLIs. Nothing here reaches a cloud.

const read = (file: string) => Bun.file(new URL(`../scripts/${file}`, import.meta.url)).text();
const cloudRun = await read("deploy-cloud-run.sh");
const ecs = await read("deploy-ecs.sh");
afterAll(cleanUp);

const A = "a".repeat(40);
const B = "b".repeat(40);
const TOKEN = "eyJ-oidc-token-value";
const ACCESS = "stub-access-token-value";

const GCP_ENV = {
  ORCH_DEPLOY_ENV: "staging",
  ORCH_DEPLOY_SHA: A,
  ORCH_CLOUD_PROJECT: "acme-staging-123",
  ORCH_CLOUD_REGION: "europe-west2",
  ORCH_CLOUD_SERVICE: "staging-web-service",
  ORCH_CLOUD_REPOSITORY: "staging-web-service",
  ORCH_CLOUD_PROVIDER:
    "projects/123456789/locations/global/workloadIdentityPools/staging-web-deploy/providers/github",
  ORCH_CLOUD_SERVICE_ACCOUNT: "staging-web-deploy@acme-staging-123.iam.gserviceaccount.com",
  ORCH_OIDC_TOKEN: TOKEN,
};

const gcloud = stub(
  "gcloud",
  `case "$1 $2" in
  "auth login")
    cred="\${3#--cred-file=}"
    /bin/cat "$cred" > "$OUT/credentials.json"
    /bin/ls -l "$(sed -n 's/.*"file":"\\([^"]*\\)".*/\\1/p' "$cred")" > "$OUT/token-file"
    echo "$CLOUDSDK_CONFIG $DOCKER_CONFIG" > "$OUT/state-dirs" ;;
  "auth print-access-token") echo ${ACCESS} ;;
  "artifacts docker") [ "\${STUB_IMAGE:-absent}" = present ] || exit 1 ;;
  "run services")
    case "$3" in describe) echo https://staging-web-service-abc.a.run.app ;; esac ;;
esac`,
);
const docker = stub("docker", `case "$1" in login) /bin/cat > "$OUT/docker-login-stdin" ;; esac`);

const IMAGE = `europe-west2-docker.pkg.dev/acme-staging-123/staging-web-service/app:${A}`;
const runCloudRun = (env: Record<string, string> = {}, extra: Record<string, string> = {}) =>
  runScript(cloudRun, {
    env: { ...GCP_ENV, ...extra, ...env },
    stubs: { gcloud, docker },
  });

describe("deploy-cloud-run.sh", () => {
  test("builds the commit's image, pushes it, updates the service and prints the URL", async () => {
    const r = await runCloudRun();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.log).toEqual([
      expect.stringMatching(/^gcloud auth login --cred-file=\S+\/credentials\.json --quiet$/),
      `gcloud artifacts docker images describe ${IMAGE} --project acme-staging-123`,
      "gcloud auth print-access-token",
      "docker login --username oauth2accesstoken --password-stdin europe-west2-docker.pkg.dev",
      `docker build --pull -f Dockerfile -t ${IMAGE} .`,
      `docker push ${IMAGE}`,
      `gcloud run services update staging-web-service --project acme-staging-123 --region europe-west2 --image ${IMAGE} --quiet`,
      "gcloud run services describe staging-web-service --project acme-staging-123 --region europe-west2 --format value(status.url)",
    ]);
    expect(r.out["docker-login-stdin"]?.trim()).toBe(ACCESS);
    expect(r.stdout).toContain(
      `staging-web-service is running ${A} in staging at https://staging-web-service-abc.a.run.app`,
    );
  });

  test("an image that is already there is deployed as it is: nothing is built, pushed or logged in to", async () => {
    const r = await runCloudRun({}, { STUB_IMAGE: "present", ORCH_DEPLOY_SHA: B });
    expect(r.code).toBe(0);
    expect(r.log.filter((l) => l.startsWith("docker"))).toEqual([]);
    expect(r.log.some((l) => l.includes("print-access-token"))).toBe(false);
    expect(
      r.log.some(
        (l) => l.startsWith("gcloud run services update") && l.includes(`app:${B} --quiet`),
      ),
    ).toBe(true);
  });

  test("the Dockerfile and the context are the ones named", async () => {
    const r = await runCloudRun({}, { ORCH_DOCKERFILE: "ops/Dockerfile", ORCH_CONTEXT: "app" });
    expect(r.log).toContain(`docker build --pull -f ops/Dockerfile -t ${IMAGE} app`);
  });

  test("signs in with a configuration that points at the token and holds no secret; no key is left behind", async () => {
    const r = await runCloudRun();
    const cred = JSON.parse(r.out["credentials.json"] ?? "{}");
    expect(cred.type).toBe("external_account");
    expect(cred.audience).toBe(`//iam.googleapis.com/${GCP_ENV.ORCH_CLOUD_PROVIDER}`);
    expect(cred.service_account_impersonation_url).toContain(GCP_ENV.ORCH_CLOUD_SERVICE_ACCOUNT);
    expect(JSON.stringify(cred)).not.toContain(TOKEN);
    // the token file is the owner's alone, and everything the script and the CLIs keep is in a directory it removes
    expect(r.out["token-file"]).toMatch(/^-rw-------/);
    const [gcloudDir, dockerDir] = (r.out["state-dirs"] ?? "").trim().split(" ");
    expect(gcloudDir?.startsWith(`${r.dir}/tmp/`)).toBe(true);
    expect(dockerDir?.startsWith(`${r.dir}/tmp/`)).toBe(true);
    expect(r.left).toEqual({ home: [], repo: ["Dockerfile"], tmp: [] });
  });

  test("a variable is never echoed: not the token, not the access token", async () => {
    const r = await runCloudRun();
    for (const secret of [TOKEN, ACCESS]) {
      expect(r.stdout + r.stderr, secret).not.toContain(secret);
      expect(r.log.join("\n"), secret).not.toContain(secret);
    }
  });

  test.each([
    ["gcloud:auth login"],
    ["docker:login"],
    ["docker:build"],
    ["docker:push"],
    ["gcloud:run services"],
  ])("a failing %s fails the script and nothing after it runs", async (failing) => {
    const r = await runCloudRun({ STUB_FAIL: failing });
    expect(r.code).not.toBe(0);
    const last = r.log.at(-1) ?? "";
    const [tool, sub] = failing.split(":") as [string, string];
    expect(
      last.startsWith(`${tool} ${sub.split(" ")[0]}`),
      `${failing}: ${r.log.join(" | ")}`,
    ).toBe(true);
    expect(r.left.tmp).toEqual([]);
  });

  const hostile = [
    "a;b",
    "$(touch pwned)",
    "`touch pwned`",
    "a b",
    "'",
    '"',
    "&&",
    "|",
    ">x",
    "a\nb",
    "-x",
    "",
    "a\\b",
  ];
  test.each(Object.keys(GCP_ENV).filter((k) => k !== "ORCH_OIDC_TOKEN"))(
    "a bad %s stops before the CLI is asked",
    async (name) => {
      for (const value of [
        ...hostile,
        ...(name === "ORCH_DEPLOY_SHA" ? ["abc", "A".repeat(40), "a".repeat(41)] : []),
      ]) {
        const r = await runCloudRun({ [name]: value });
        expect([name, value, r.code === 0, r.log]).toEqual([name, value, false, []]);
        expect(r.stderr).toContain("deploy-cloud-run:");
        expect(r.left.repo).toEqual(["Dockerfile"]);
      }
    },
  );

  test.each(["ORCH_DOCKERFILE", "ORCH_CONTEXT"])(
    "a bad %s stops before the CLI is asked",
    async (name) => {
      for (const value of ["../x", "/etc/x", "-x", "a b", "a;b", "$(x)"]) {
        const r = await runCloudRun({ [name]: value });
        expect([name, value, r.code === 0, r.log]).toEqual([name, value, false, []]);
      }
    },
  );

  test("without a token it stops before the CLI is asked", async () => {
    const r = await runCloudRun({ ORCH_OIDC_TOKEN: "" });
    expect(r.code).not.toBe(0);
    expect(r.log).toEqual([]);
    expect(r.stderr).toContain("ORCH_OIDC_TOKEN");
  });

  test("a credential the runner already holds is not used", async () => {
    const r = await runScript(`${cloudRun}\n`, {
      env: { ...GCP_ENV, GOOGLE_APPLICATION_CREDENTIALS: "/x/key.json" },
      stubs: {
        gcloud: stub("gcloud", `echo "adc=\${GOOGLE_APPLICATION_CREDENTIALS:-none}" > "$OUT/adc"`),
        docker,
      },
    });
    expect(r.out.adc?.trim()).toBe("adc=none");
  });
});

// ---------------------------------------------------------------------------------------------------------------

const ACCOUNT = "123456789012";
const AWS_ENV = {
  ORCH_DEPLOY_ENV: "staging",
  ORCH_DEPLOY_SHA: A,
  ORCH_CLOUD_ACCOUNT: ACCOUNT,
  ORCH_CLOUD_REGION: "eu-west-2",
  ORCH_CLOUD_ROLE: "staging-web-deploy",
  ORCH_CLOUD_CLUSTER: "staging-web-service",
  ORCH_CLOUD_SERVICE: "staging-web-service",
  ORCH_CLOUD_REPOSITORY: "staging-web-service",
  ORCH_OIDC_TOKEN: TOKEN,
};
const TASK_ARN = `arn:aws:ecs:eu-west-2:${ACCOUNT}:task-definition/staging-web-service:7`;
const NEW_ARN = `arn:aws:ecs:eu-west-2:${ACCOUNT}:task-definition/staging-web-service:8`;
const DEFINITION = JSON.stringify(
  {
    family: "staging-web-service",
    taskRoleArn: "arn:aws:iam::1:role/t",
    cpu: "256",
    containerDefinitions: [{ name: "app", image: "placeholder:latest", essential: true }],
  },
  null,
  4,
);

const aws = stub(
  "aws",
  `case "$1 $2" in
  "sts get-caller-identity")
    echo "$AWS_ROLE_ARN $AWS_WEB_IDENTITY_TOKEN_FILE $AWS_REGION key=\${AWS_ACCESS_KEY_ID:-none}" > "$OUT/identity"
    /bin/ls -l "$AWS_WEB_IDENTITY_TOKEN_FILE" > "$OUT/token-file"
    echo "$DOCKER_CONFIG" > "$OUT/state-dirs" ;;
  "ecr describe-images")
    case "\${STUB_IMAGE:-absent}" in
      present) echo sha256:abc ;;
      denied) echo "AccessDeniedException" >&2; exit 254 ;;
      *) echo "An error occurred (ImageNotFoundException) when calling DescribeImages" >&2; exit 254 ;;
    esac ;;
  "ecr get-login-password") echo ${ACCESS} ;;
  "ecs describe-services") echo ${TASK_ARN} ;;
  "ecs describe-task-definition")
    case "$*" in
      *"length("*) echo "\${STUB_VOLUMES:-0}" ;;
      *) cat <<'JSON'
${DEFINITION}
JSON
      ;;
    esac ;;
  "ecs register-task-definition")
    /bin/cat "\${4#file://}" > "$OUT/registered.json"
    echo ${NEW_ARN} ;;
esac`,
);

const REGISTRY = `${ACCOUNT}.dkr.ecr.eu-west-2.amazonaws.com`;
const ECR_IMAGE = `${REGISTRY}/staging-web-service:${A}`;
const runEcs = (env: Record<string, string> = {}, extra: Record<string, string> = {}) =>
  runScript(ecs, { env: { ...AWS_ENV, ...extra, ...env }, stubs: { aws, docker } });

describe("deploy-ecs.sh", () => {
  test("builds the commit's image, pushes it, registers a revision with it, updates the service and waits", async () => {
    const r = await runEcs();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.log).toEqual([
      "aws sts get-caller-identity",
      `aws ecr describe-images --repository-name staging-web-service --image-ids imageTag=${A} --query imageDetails[0].imageDigest --output text`,
      "aws ecr get-login-password",
      `docker login --username AWS --password-stdin ${REGISTRY}`,
      `docker build --pull -f Dockerfile -t ${ECR_IMAGE} .`,
      `docker push ${ECR_IMAGE}`,
      "aws ecs describe-services --cluster staging-web-service --services staging-web-service --query services[0].taskDefinition --output text",
      `aws ecs describe-task-definition --task-definition ${TASK_ARN} --query length(taskDefinition.volumes) --output text`,
      expect.stringContaining(
        `aws ecs describe-task-definition --task-definition ${TASK_ARN} --output json --query taskDefinition.{family:family,`,
      ),
      expect.stringMatching(
        /^aws ecs register-task-definition --cli-input-json file:\/\/\S+\/next\.json --query taskDefinition\.taskDefinitionArn --output text$/,
      ),
      `aws ecs update-service --cluster staging-web-service --service staging-web-service --task-definition ${NEW_ARN}`,
      "aws ecs wait services-stable --cluster staging-web-service --services staging-web-service",
    ]);
    const registered = JSON.parse(r.out["registered.json"] ?? "{}");
    expect(registered.containerDefinitions).toEqual([
      { name: "app", image: ECR_IMAGE, essential: true },
    ]);
    expect(registered.family).toBe("staging-web-service");
    expect(r.stdout).toContain(`staging-web-service is running ${A} in staging`);
  });

  test("an image that is already in the repository is deployed as it is: nothing is built, pushed or logged in to", async () => {
    const r = await runEcs(
      {},
      { STUB_IMAGE: "present", ORCH_DEPLOY_SHA: B, ORCH_SERVICE_URL: "https://web.example.com" },
    );
    expect(r.code).toBe(0);
    expect(r.log.filter((l) => l.startsWith("docker") || l.includes("get-login-password"))).toEqual(
      [],
    );
    expect(JSON.parse(r.out["registered.json"] ?? "{}").containerDefinitions[0].image).toBe(
      `${REGISTRY}/staging-web-service:${B}`,
    );
    expect(r.stdout).toContain("at https://web.example.com");
  });

  test("a repository it could not read is not taken for an empty one", async () => {
    const r = await runEcs({}, { STUB_IMAGE: "denied" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("could not read the repository");
    expect(r.log.filter((l) => l.startsWith("docker"))).toEqual([]);
  });

  test("signs in with the role and the token file, drops an access key it was given, and leaves nothing behind", async () => {
    const r = await runEcs({}, { AWS_ACCESS_KEY_ID: "AKIAWHATEVER" });
    const [role, file, region, key] = (r.out.identity ?? "").trim().split(" ");
    expect(role).toBe(`arn:aws:iam::${ACCOUNT}:role/staging-web-deploy`);
    expect(file?.startsWith(`${r.dir}/tmp/`)).toBe(true);
    expect([region, key]).toEqual(["eu-west-2", "key=none"]);
    expect(r.out["token-file"]).toMatch(/^-rw-------/);
    expect(r.left).toEqual({ home: [], repo: ["Dockerfile"], tmp: [] });
  });

  test("a variable is never echoed: not the token, not the registry password", async () => {
    const r = await runEcs();
    for (const secret of [TOKEN, ACCESS]) {
      expect(r.stdout + r.stderr, secret).not.toContain(secret);
      expect(r.log.join("\n"), secret).not.toContain(secret);
    }
  });

  test.each([
    "aws:sts get-caller-identity",
    "docker:login",
    "docker:build",
    "docker:push",
    "aws:ecs register-task-definition",
    "aws:ecs update-service",
    "aws:ecs wait",
  ])("a failing %s fails the script and nothing after it runs", async (failing) => {
    const r = await runEcs({ STUB_FAIL: failing });
    expect(r.code).not.toBe(0);
    const [tool, sub] = failing.split(":") as [string, string];
    expect((r.log.at(-1) ?? "").startsWith(`${tool} ${sub}`), failing).toBe(true);
    expect(r.left.tmp).toEqual([]);
  });

  test("a service whose task definition has a volume is not deployed: the script would drop it", async () => {
    const r = await runEcs({}, { STUB_VOLUMES: "1" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("volumes");
    expect(r.log.some((l) => l.includes("register-task-definition"))).toBe(false);
  });

  const hostile = [
    "a;b",
    "$(touch pwned)",
    "`touch pwned`",
    "a b",
    "'",
    '"',
    "&&",
    "|",
    ">x",
    "a\nb",
    "-x",
    "",
    "a\\b",
  ];
  test.each(Object.keys(AWS_ENV).filter((k) => k !== "ORCH_OIDC_TOKEN"))(
    "a bad %s stops before the CLI is asked",
    async (name) => {
      const more =
        name === "ORCH_DEPLOY_SHA"
          ? ["abc", "A".repeat(40)]
          : name === "ORCH_CLOUD_ACCOUNT"
            ? ["12345678901", "1234567890123", "12345678901a"]
            : [];
      for (const value of [...hostile, ...more]) {
        const r = await runEcs({ [name]: value });
        expect([name, value, r.code === 0, r.log]).toEqual([name, value, false, []]);
        expect(r.stderr).toContain("deploy-ecs:");
      }
    },
  );
});

describe("the two scripts", () => {
  const names = (text: string) => [...new Set(text.match(/\bORCH_[A-Z0-9_]+\b/g) ?? [])].sort();

  test("read the variables of their closed lists and no other", () => {
    expect(names(cloudRun)).toEqual(
      [...Object.keys(GCP_ENV), "ORCH_CONTEXT", "ORCH_DOCKERFILE"].sort(),
    );
    expect(names(ecs)).toEqual(
      [...Object.keys(AWS_ENV), "ORCH_CONTEXT", "ORCH_DOCKERFILE", "ORCH_SERVICE_URL"].sort(),
    );
  });

  test.each([
    ["deploy-cloud-run.sh", cloudRun],
    ["deploy-ecs.sh", ecs],
  ])(
    "%s never echoes a variable, writes no key file, and never uses `eval` on a value",
    (_, text) => {
      expect(text).not.toMatch(/echo[^\n]*\$\{?ORCH_OIDC_TOKEN/);
      expect(text).not.toMatch(/(^|\s)set -x/);
      expect(text).not.toMatch(/\.(pem|key|p12)\b/);
      // the only eval is the one that reads a variable by its fixed name
      expect(text.match(/\beval\b/g)).toHaveLength(1);
      expect(text).toContain('eval "safe \\$name');
    },
  );
});
