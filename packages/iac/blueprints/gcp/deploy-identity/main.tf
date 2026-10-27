locals {
  id = "${var.environment}-${var.name}-deploy"

  # What the service resource is called. These are the same formulas its own module uses.
  service_id = "${var.environment}-${var.service}-service"
  runtime_sa = "${var.environment}-${var.service}-sa@${var.project}.iam.gserviceaccount.com"

  github = var.forge == "github"
  owner  = split("/", var.repository)[0]
  repo   = split("/", var.repository)[1]
  issuer = local.github ? "https://token.actions.githubusercontent.com" : "https://gitlab.com"

  # The one subject the forge's token carries. A GitHub job that names an environment has the environment form
  # (the deploy workflow does); GitLab's subject has the branch and never the environment.
  subject = local.github ? (
    var.immutable_subject
    ? "repo:${local.owner}@${var.owner_id}/${local.repo}@${var.repository_id}:environment:${var.environment}"
    : "repo:${var.repository}:environment:${var.environment}"
  ) : "project_path:${var.repository}:ref_type:branch:ref:${var.branch}"

  # Google's page warns that one issuer serves every repository on the forge, so the provider takes nothing
  # unless this holds: the exact subject and the numeric ids, which a renamed or recreated repository does not keep.
  condition = local.github ? join(" && ", [
    "assertion.sub == '${local.subject}'",
    "assertion.repository_id == '${var.repository_id}'",
    "assertion.repository_owner_id == '${var.owner_id}'",
    ]) : join(" && ", [
    "assertion.sub == '${local.subject}'",
    "assertion.project_id == '${var.repository_id}'",
    "assertion.namespace_id == '${var.owner_id}'",
  ])
}

resource "google_project_service" "iam" {
  service            = "iam.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "iamcredentials" {
  service            = "iamcredentials.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "sts" {
  service            = "sts.googleapis.com"
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool" "this" {
  workload_identity_pool_id = local.id
  display_name              = "Deploys ${var.service}"
  description               = "Lets the ${var.forge} repository ${var.repository} deploy ${local.service_id}"

  depends_on = [google_project_service.iam]
}

# No `allowed_audiences`: the default is the provider's own address, which is what the deploy template asks the forge for.
resource "google_iam_workload_identity_pool_provider" "this" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.this.workload_identity_pool_id
  workload_identity_pool_provider_id = var.forge
  display_name                       = var.forge

  attribute_mapping = {
    "google.subject" = "assertion.sub"
  }
  attribute_condition = local.condition

  oidc {
    issuer_uri = local.issuer
  }
}

# What the runner acts as. It holds no role of its own: it is given the three things below and nothing else.
resource "google_service_account" "this" {
  account_id   = "${var.environment}-${var.name}-dep"
  display_name = "Deploys ${local.service_id}"

  depends_on = [google_project_service.iam]
}

# The federated identity may act as the account, and only the one with this exact subject.
resource "google_service_account_iam_member" "federated" {
  service_account_id = google_service_account.this.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.this.name}/subject/${local.subject}"

  depends_on = [google_project_service.iamcredentials]
}

# Update the one service ...
resource "google_cloud_run_v2_service_iam_member" "deploy" {
  project  = var.project
  location = var.region
  name     = local.service_id
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.this.email}"
}

# ... with the identity the service runs as ...
resource "google_service_account_iam_member" "runtime" {
  service_account_id = "projects/${var.project}/serviceAccounts/${local.runtime_sa}"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.this.email}"
}

# ... and push the image it runs to the service's own repository.
resource "google_artifact_registry_repository_iam_member" "push" {
  project    = var.project
  location   = var.region
  repository = local.service_id
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.this.email}"
}
