output "url" {
  value       = google_cloud_run_v2_service.this.uri
  description = "The service's address. Reachable from the internet only when public is on."
}

output "console_url" {
  value       = "https://console.cloud.google.com/run/detail/${var.region}/${google_cloud_run_v2_service.this.name}/metrics?project=${var.project}"
  description = "Where the service is in the console."
}

output "repository" {
  value       = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.this.repository_id}"
  description = "Where this service's images are pushed (feature 36 deploys from here)."
}

output "service_account" {
  value       = google_service_account.this.email
  description = "The identity the service runs as."
}
