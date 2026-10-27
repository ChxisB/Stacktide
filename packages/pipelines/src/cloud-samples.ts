/** Parameters the cloud templates cannot default (a project, a service, an identity): the tests render them with these. */
export const SAMPLE_PARAMS: Record<string, Record<string, string>> = {
  "cloud-run": {
    project: "acme-staging-123",
    region: "europe-west2",
    service: "staging-web-service",
    repository: "staging-web-service",
    provider:
      "projects/123456789/locations/global/workloadIdentityPools/staging-web-deploy/providers/github",
    serviceAccount: "staging-web-deploy@acme-staging-123.iam.gserviceaccount.com",
    deployImage: "example/gcloud-docker:1",
  },
  ecs: {
    account: "123456789012",
    region: "eu-west-2",
    role: "staging-web-deploy",
    cluster: "staging-web-service",
    service: "staging-web-service",
    repository: "staging-web-service",
    deployImage: "example/aws-docker:1",
  },
};
