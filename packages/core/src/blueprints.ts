import { z } from "zod";
import { POOL_IMAGE } from "./pools";

/**
 * What a resource can be (ADR-0024). The inputs below are the only way a value reaches the
 * Terraform the platform writes, so every string is a closed character set or an enum: there is no
 * free-text field, and no field a secret could be put in.
 */
export const BLUEPRINT_KINDS = [
  "network",
  "service",
  "postgres",
  "bucket",
  "deploy-identity",
] as const;
export const BLUEPRINT_CLOUDS = ["gcp", "aws"] as const;
export const BLUEPRINT_PROFILES = ["small", "medium", "large"] as const;
export type BlueprintKind = (typeof BLUEPRINT_KINDS)[number];
export type BlueprintCloud = (typeof BLUEPRINT_CLOUDS)[number];
export type BlueprintProfile = (typeof BLUEPRINT_PROFILES)[number];

/**
 * An environment and a resource name are each at most 12 characters, so the stack name
 * `<environment>-<name>-<kind>` is at most 34, and cloud names built from the first two still fit
 * (`<environment>-<name>-sa` is a GCP service account id, capped at 30; a load balancer is capped at 32).
 */
export const BLUEPRINT_PART_MAX = 12;
const PART = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const GCP_REGION = /^[a-z]+-[a-z]+[0-9]{1,2}$/;
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-[0-9]{1,2}$/;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;
const ACM_CERTIFICATE =
  /^arn:aws(-[a-z]+)*:acm:[a-z]{2}(-[a-z]+)+-[0-9]{1,2}:[0-9]{12}:certificate\/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const USE = /^(network|service|postgres|bucket):([a-z][a-z0-9]*(-[a-z0-9]+)*)$/;
// A repository path has none of the characters a subject is built from (`:`, `@`, `%`), so a value cannot write more of it.
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}(\/[A-Za-z0-9_.-]{1,100}){1,19}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

/** What a kind may list in `uses`. A service reaches a database and a bucket through its network. */
export const BLUEPRINT_USES: Record<BlueprintKind, readonly BlueprintKind[]> = {
  network: [],
  bucket: [],
  postgres: ["network"],
  service: ["network", "postgres", "bucket"],
  // the service it deploys; nothing uses an identity
  "deploy-identity": ["service"],
};

const part = (what: string) =>
  z
    .string()
    .max(BLUEPRINT_PART_MAX, `must be at most ${BLUEPRINT_PART_MAX} characters`)
    .regex(
      PART,
      `${what} must be lowercase letters, digits and single dashes, starting with a letter`,
    );

/**
 * A private IPv4 range from /16 to /24 inside 10/8, 172.16/12 or 192.168/16. The AWS module cuts it into four
 * subnets (a /24 gives four /28, the smallest AWS takes) and a VPC cannot be larger than a /16.
 */
const privateCidr = (v: string) => {
  const m = CIDR.exec(v);
  if (!m) return false;
  const [a, b, c, d, bits] = m.slice(1).map(Number) as [number, number, number, number, number];
  if ([a, b, c, d].some((o) => o > 255) || bits < 16 || bits > 24) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

const base = {
  environment: part("environment"),
  name: part("name"),
  cloud: z.enum(BLUEPRINT_CLOUDS),
  region: z.string().max(32),
  /** The GCP project id; an AWS account is the runner's credential and is not an input. */
  project: z.string().regex(GCP_PROJECT, "must be a GCP project id").optional(),
  profile: z.enum(BLUEPRINT_PROFILES).default("small"),
  /** `kind:name` of resources in the same environment and cloud (checked when they are known). */
  uses: z.array(z.string().regex(USE, "must be kind:name, like postgres:main")).max(8).default([]),
};

const network = z.strictObject({
  ...base,
  kind: z.literal("network"),
  cidr: z
    .string()
    .refine(privateCidr, "must be a private IPv4 range from /16 to /24, like 10.20.0.0/16")
    .default("10.20.0.0/16"),
});
const service = z.strictObject({
  ...base,
  kind: z.literal("service"),
  /** An image reference; a placeholder runs until the first deploy (feature 36) when it is left out. */
  image: z.string().regex(POOL_IMAGE, "must be an image reference without credentials").optional(),
  port: z.number().int().min(1).max(65535).default(8080),
  /** Takes unauthenticated traffic. Off unless asked for. */
  public: z.boolean().default(false),
  /** AWS only: the load balancer speaks HTTPS and nothing else, so it needs a certificate. */
  certificateArn: z.string().regex(ACM_CERTIFICATE, "must be an ACM certificate ARN").optional(),
});
const postgres = z.strictObject({
  ...base,
  kind: z.literal("postgres"),
  version: z.enum(["15", "16", "17"]).default("16"),
});
const bucket = z.strictObject({
  ...base,
  kind: z.literal("bucket"),
  versioning: z.boolean().default(false),
});

/**
 * The identity a forge's runner signs in as to deploy one service (ADR-0025). It trusts one repository by the
 * exact subject its OIDC token carries and by the repository's numeric ids, never by a pattern; the module
 * grants it the one service and the one image repository named by `uses`.
 */
const deployIdentity = z.strictObject({
  ...base,
  kind: z.literal("deploy-identity"),
  /** github.com and gitlab.com only: a self-managed issuer is not checked (docs/cloud-deploy-spike.md). */
  forge: z.enum(["github", "gitlab"]),
  /** `owner/repository` on GitHub, `group/subgroup/project` on GitLab. */
  repository: z.string().max(200).regex(REPOSITORY, "must be a repository path, like acme/web"),
  /** GitHub's `repository_id` and `repository_owner_id`, GitLab's `project_id` and `namespace_id`: names can be taken over, ids cannot. */
  repositoryId: z.number().int().positive(),
  ownerId: z.number().int().positive(),
  /** GitLab only: the subject names the branch (and not the environment). */
  branch: z.string().regex(BRANCH, "must be a branch name, like main").optional(),
  /** GitHub only: repositories created after 2026-07-15, or opted in, carry ids in the subject. */
  immutableSubject: z.boolean().default(false),
  /** AWS only: an account has one OIDC provider for an issuer, so a second identity reuses the first one's. */
  existingOidcProvider: z.boolean().default(false),
});

export const BlueprintSchema = z
  .discriminatedUnion("kind", [network, service, postgres, bucket, deployIdentity])
  .superRefine((b, ctx) => {
    const refuse = (key: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [key], message });
    if (b.cloud === "gcp") {
      if (!GCP_REGION.test(b.region)) refuse("region", "must be a GCP region, like us-central1");
      if (b.project === undefined) refuse("project", "is required on GCP");
    } else {
      if (!AWS_REGION.test(b.region)) refuse("region", "must be an AWS region, like eu-west-2");
      if (b.project !== undefined) refuse("project", "is for GCP: an AWS account is the runner's");
    }
    if (b.kind === "service") {
      if (b.cloud === "aws" && b.certificateArn === undefined) {
        refuse("certificateArn", "is required on AWS: the load balancer serves HTTPS only");
      }
      if (b.cloud === "gcp" && b.certificateArn !== undefined) {
        refuse("certificateArn", "is for AWS: Cloud Run serves HTTPS itself");
      }
    }
    if (b.kind === "deploy-identity") {
      const github = b.forge === "github";
      if (github && b.repository.split("/").length !== 2) {
        refuse("repository", "is owner/repository on GitHub, like acme/web");
      }
      if (!github && b.branch === undefined) {
        refuse("branch", "is required on GitLab: the subject names it");
      }
      if (github && b.branch !== undefined) {
        refuse(
          "branch",
          "is for GitLab: a GitHub job that names an environment has no ref in its subject",
        );
      }
      if (!github && b.immutableSubject) {
        refuse("immutableSubject", "is for GitHub: GitLab's subject has no immutable form");
      }
      if (b.cloud === "gcp" && b.existingOidcProvider) {
        refuse(
          "existingOidcProvider",
          "is for AWS: a workload identity pool is made by this stack",
        );
      }
      if (b.uses.filter((u) => u.startsWith("service:")).length !== 1) {
        refuse("uses", "a deploy-identity deploys one service: add service:<name> to uses");
      }
    }
    // the modules take the network by name and have no default for it
    const networks = b.uses.filter((u) => u.startsWith("network:")).length;
    if (networks > 1) refuse("uses", "only one network can be used");
    if (networks === 0 && b.kind === "postgres") {
      refuse("uses", "a postgres needs a network: add network:<name> to uses");
    }
    if (networks === 0 && b.kind === "service") {
      if (b.cloud === "aws") {
        refuse("uses", "a service on AWS needs a network: add network:<name> to uses");
      } else if (b.uses.some((u) => u.startsWith("postgres:"))) {
        // a database has a private address only, which Cloud Run reaches through the network
        refuse(
          "uses",
          "a service that uses a postgres needs a network: add network:<name> to uses",
        );
      }
    }
    const seen = new Set<string>();
    for (const use of b.uses) {
      const m = USE.exec(use);
      if (!m) continue; // the field's own issue says so
      const [, kind, name] = m as unknown as [string, BlueprintKind, string];
      if (name.length > BLUEPRINT_PART_MAX) refuse("uses", `${use}: the name is too long`);
      if (kind === b.kind && name === b.name) refuse("uses", `${use} is the resource itself`);
      else if (!BLUEPRINT_USES[b.kind].includes(kind)) {
        refuse("uses", `a ${b.kind} cannot use a ${kind} (${use})`);
      }
      if (seen.has(use)) refuse("uses", `${use} is listed twice`);
      seen.add(use);
    }
  });
export type Blueprint = z.output<typeof BlueprintSchema>;
export type BlueprintInput = z.input<typeof BlueprintSchema>;

/** The stack a resource is rendered as. Its name is also its state key, so it is unique in the project. */
export const stackNameOf = (b: Pick<Blueprint, "environment" | "name" | "kind">) =>
  `${b.environment}-${b.name}-${b.kind}`;

/**
 * What `uses` needs of the project's other resources, which the schema cannot see: each one is in this
 * environment and on this cloud, and a service and its databases share one network; and no other
 * resource has the same stack name, which a dash can cause (`dev-eu` + `main` and `dev` + `eu-main`) and
 * which is the state key. No kind can reach itself (`BLUEPRINT_USES` has no cycle, and a test says so),
 * so there is no cycle to look for. The others only answer these questions; none of their values is
 * written anywhere.
 */
export function checkBlueprintWiring(b: Blueprint, others: readonly Blueprint[]): string[] {
  const networkOf = (r: Blueprint) => r.uses.find((u) => u.startsWith("network:"));
  const errors: string[] = [];
  const stack = stackNameOf(b);
  const clash = others.find(
    (o) => stackNameOf(o) === stack && !(o.environment === b.environment && o.name === b.name),
  );
  if (clash) {
    errors.push(
      `name: ${stack} is already the stack of ${clash.environment}/${clash.name}, since a dash runs two names together`,
    );
  }
  for (const use of b.uses) {
    const [kind, name] = use.split(":");
    const o = others.find(
      (r) => r.environment === b.environment && r.kind === kind && r.name === name,
    );
    if (!o) errors.push(`uses: ${use} is not a resource of ${b.environment}`);
    else if (o.cloud !== b.cloud) errors.push(`uses: ${use} is on ${o.cloud}, not ${b.cloud}`);
    else if (b.kind === "deploy-identity" && (o.region !== b.region || o.project !== b.project)) {
      // the identity's names and ARNs are built from where it is, so they would name nothing
      errors.push(
        `uses: ${use} is not where this deploy identity is: region and project must match`,
      );
    } else if (b.kind === "service" && o.kind === "postgres" && networkOf(o) !== networkOf(b)) {
      errors.push(`uses: ${use} is on ${networkOf(o)}, but this service uses ${networkOf(b)}`);
    }
  }
  return errors;
}

/** `kind:name`, as `uses` writes it. */
export const useOf = (b: Pick<Blueprint, "name" | "kind">) => `${b.kind}:${b.name}`;

/** What a profile means in each cloud: a reviewed table, so no machine size is ever typed by hand. */
export const BLUEPRINT_SIZES = {
  gcp: {
    service: {
      small: { cpu: "1", memory: "512Mi", minInstances: 0, maxInstances: 3 },
      medium: { cpu: "1", memory: "1Gi", minInstances: 1, maxInstances: 10 },
      large: { cpu: "2", memory: "2Gi", minInstances: 2, maxInstances: 20 },
    },
    postgres: {
      small: { tier: "db-f1-micro", storageGb: 10 },
      medium: { tier: "db-custom-1-3840", storageGb: 50 },
      large: { tier: "db-custom-2-7680", storageGb: 100 },
    },
  },
  aws: {
    service: {
      small: { cpu: 256, memory: 512, desiredCount: 1 },
      medium: { cpu: 512, memory: 1024, desiredCount: 2 },
      large: { cpu: 1024, memory: 2048, desiredCount: 3 },
    },
    postgres: {
      small: { instanceClass: "db.t4g.micro", storageGb: 20 },
      medium: { instanceClass: "db.t4g.small", storageGb: 50 },
      large: { instanceClass: "db.m7g.large", storageGb: 100 },
    },
  },
} as const;
