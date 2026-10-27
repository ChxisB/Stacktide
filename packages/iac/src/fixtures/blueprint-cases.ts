/** One input of every kind on both clouds, shared by the renderer's tests and its opt-in Terraform check. */
import { type Blueprint, BlueprintSchema } from "@orch/core";

const CERT = "arn:aws:acm:eu-west-2:123456789012:certificate/12345678-1234-1234-1234-123456789012";
const GCP = { cloud: "gcp", region: "us-central1", project: "my-proj-123" };
const AWS = { cloud: "aws", region: "eu-west-2" };

const IDENTITY = {
  kind: "deploy-identity",
  repository: "acme/web",
  repositoryId: 1234567,
  ownerId: 7654321,
};

/** One input of every kind on both clouds; the services use everything they can. */
export const CASES: Record<string, Record<string, unknown>> = {
  "network gcp": { ...GCP, kind: "network" },
  "network aws": { ...AWS, kind: "network", cidr: "10.30.0.0/20" },
  "service gcp": {
    ...GCP,
    kind: "service",
    image: "europe-docker.pkg.dev/my-proj-123/staging/app:1.2.3",
    port: 3000,
    public: true,
    profile: "medium",
    uses: ["network:main", "postgres:main", "bucket:files"],
  },
  "service gcp bare": { ...GCP, kind: "service" },
  "service aws": {
    ...AWS,
    kind: "service",
    certificateArn: CERT,
    profile: "large",
    uses: ["bucket:files", "postgres:main", "network:main"],
  },
  "postgres gcp": { ...GCP, kind: "postgres", version: "17", uses: ["network:main"] },
  "postgres aws": {
    ...AWS,
    kind: "postgres",
    profile: "medium",
    uses: ["network:main"],
  },
  "bucket gcp": { ...GCP, kind: "bucket", versioning: true },
  "bucket aws": { ...AWS, kind: "bucket" },
  "deploy-identity gcp github": { ...GCP, ...IDENTITY, forge: "github", uses: ["service:web"] },
  "deploy-identity gcp gitlab": {
    ...GCP,
    ...IDENTITY,
    forge: "gitlab",
    branch: "main",
    uses: ["service:web"],
  },
  "deploy-identity aws github": {
    ...AWS,
    ...IDENTITY,
    forge: "github",
    immutableSubject: true,
    existingOidcProvider: true,
    uses: ["service:web"],
  },
  "deploy-identity aws gitlab": {
    ...AWS,
    ...IDENTITY,
    forge: "gitlab",
    branch: "main",
    uses: ["service:web"],
  },
};
export const input = (which: string, over: Record<string, unknown> = {}) => ({
  environment: "staging",
  name: "main",
  ...CASES[which],
  ...over,
});

/** The resources the services' `uses` name, as the project's other resources. */
export const siblings = (cloud: "gcp" | "aws"): Blueprint[] => {
  const where = cloud === "gcp" ? GCP : AWS;
  const make = (kind: string, name: string, over: Record<string, unknown> = {}) =>
    BlueprintSchema.parse({ environment: "staging", name, ...where, kind, ...over });
  return [
    make("network", "main"),
    make("postgres", "main", { uses: ["network:main"] }),
    make("bucket", "files"),
    make("service", "web", cloud === "aws" ? { uses: ["network:main"], certificateArn: CERT } : {}),
  ];
};
/** The other resources a case is rendered beside. */
export const othersOf = (which: string) => siblings(CASES[which]?.cloud as "gcp" | "aws");
