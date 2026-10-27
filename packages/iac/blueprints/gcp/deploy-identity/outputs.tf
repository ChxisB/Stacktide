output "console_url" {
  value       = "https://console.cloud.google.com/iam-admin/workload-identity-pools/pool/${google_iam_workload_identity_pool.this.workload_identity_pool_id}?project=${var.project}"
  description = "Where the workload identity pool is in the console."
}

output "provider" {
  value       = google_iam_workload_identity_pool_provider.this.name
  description = "The provider's full resource name: the deploy template's `provider` value."
}

output "service_account" {
  value       = google_service_account.this.email
  description = "The account the deploy acts as: the deploy template's `serviceAccount` value."
}
