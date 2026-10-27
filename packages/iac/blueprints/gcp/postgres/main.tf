locals {
  id           = "${var.environment}-${var.name}-postgres"
  network_name = "${var.environment}-${var.network}-network"

  # The name a service in this environment mounts. It is the same formula the service module uses.
  secret_id = "${var.environment}-${var.name}-database-url"
}

resource "google_project_service" "sqladmin" {
  service            = "sqladmin.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secretmanager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

# The network stack applied first (depends_on in stack.yml): it holds the private service access this
# instance's address is taken from.
data "google_compute_network" "this" {
  name = local.network_name
}

# Cloud SQL keeps an instance's name for a week after it is deleted, so a database that is torn down and made
# again with the same name would fail. The suffix is chosen once and stays in the state.
resource "random_id" "suffix" {
  byte_length = 3
}

resource "random_password" "database" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "this" {
  name             = "${local.id}-${random_id.suffix.hex}"
  region           = var.region
  database_version = "POSTGRES_${var.postgres_version}"

  # Two switches: this one stops Terraform from deleting the instance, the one in settings stops anyone else.
  deletion_protection = true

  settings {
    tier                        = var.tier
    edition                     = "ENTERPRISE"
    availability_type           = "ZONAL"
    disk_size                   = var.storage_gb
    disk_autoresize             = true
    deletion_protection_enabled = true

    ip_configuration {
      ipv4_enabled    = false
      private_network = data.google_compute_network.this.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }

  depends_on = [google_project_service.sqladmin]
}

resource "google_sql_database" "app" {
  name     = "app"
  instance = google_sql_database_instance.this.name
}

resource "google_sql_user" "app" {
  name     = "app"
  instance = google_sql_database_instance.this.name
  password = random_password.database.result
}

resource "google_secret_manager_secret" "url" {
  secret_id = local.secret_id

  replication {
    auto {}
  }

  depends_on = [google_project_service.secretmanager]
}

# The one place the connection string is written. The password is also in this stack's state, which the
# platform keeps sealed (ADR-0017); it is in no output.
resource "google_secret_manager_secret_version" "url" {
  secret      = google_secret_manager_secret.url.id
  secret_data = "postgres://app:${random_password.database.result}@${google_sql_database_instance.this.private_ip_address}:5432/app?sslmode=require"

  depends_on = [google_sql_database.app, google_sql_user.app]
}
