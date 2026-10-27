locals {
  id = "${var.environment}-${var.name}-service"

  # What other resources in the environment are called. These are the same formulas their own modules use.
  network_name = "${var.environment}-${var.network}-network"
  secret_ids   = { for d in var.databases : d => "${var.environment}-${d}-database-url" }
  bucket_names = { for b in var.buckets : b => "${var.environment}-${b}-${substr(sha256(var.project), 0, 8)}" }

  # One database is DATABASE_URL; several are DATABASE_URL_<NAME>.
  database_env = {
    for d, secret in local.secret_ids :
    (length(var.databases) == 1 ? "DATABASE_URL" : "DATABASE_URL_${upper(replace(d, "-", "_"))}") => secret
  }
  bucket_env = { for b, bucket in local.bucket_names : "BUCKET_${upper(replace(b, "-", "_"))}" => bucket }

  image = var.image == "" ? "us-docker.pkg.dev/cloudrun/container/hello" : var.image
  port  = var.image == "" ? 8080 : var.port
}

resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "this" {
  repository_id = local.id
  location      = var.region
  format        = "DOCKER"
  description   = "Images of ${local.id}"

  depends_on = [google_project_service.artifactregistry]
}

# The identity the service runs as. It holds no role of its own: it is given exactly the secrets and the
# buckets named in `databases` and `buckets`, below, and nothing else.
resource "google_service_account" "this" {
  account_id   = "${var.environment}-${var.name}-sa"
  display_name = "Runs ${local.id}"
}

resource "google_secret_manager_secret_iam_member" "database" {
  for_each = local.secret_ids

  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.this.email}"

  depends_on = [google_project_service.secretmanager]
}

resource "google_storage_bucket_iam_member" "bucket" {
  for_each = local.bucket_names

  bucket = each.value
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.this.email}"
}

resource "google_cloud_run_v2_service" "this" {
  name     = local.id
  location = var.region
  ingress  = var.public ? "INGRESS_TRAFFIC_ALL" : "INGRESS_TRAFFIC_INTERNAL_ONLY"

  # A service keeps no data, so a teardown is allowed to delete it.
  deletion_protection = false

  template {
    service_account = google_service_account.this.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    # Direct VPC egress: the service reaches a private database without a connector to pay for.
    dynamic "vpc_access" {
      for_each = var.network == "" ? [] : [1]
      content {
        egress = "PRIVATE_RANGES_ONLY"
        network_interfaces {
          network    = local.network_name
          subnetwork = local.network_name
        }
      }
    }

    containers {
      image = local.image

      ports {
        container_port = local.port
      }

      resources {
        limits = {
          cpu    = var.cpu
          memory = var.memory
        }
      }

      dynamic "env" {
        for_each = local.database_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      dynamic "env" {
        for_each = local.bucket_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }

  # Deploys (feature 36) set the image after the first apply; a later apply must not put the hello image back.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.run,
    google_secret_manager_secret_iam_member.database,
    google_storage_bucket_iam_member.bucket,
  ]
}

# The only place anyone but the service's callers is let in, and only when `public` is on.
resource "google_cloud_run_v2_service_iam_member" "public" {
  count = var.public ? 1 : 0

  name     = google_cloud_run_v2_service.this.name
  location = google_cloud_run_v2_service.this.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
