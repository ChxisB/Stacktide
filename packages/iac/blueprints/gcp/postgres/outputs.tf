output "instance_name" {
  value       = google_sql_database_instance.this.name
  description = "The Cloud SQL instance, with its random suffix."
}

output "secret_id" {
  value       = google_secret_manager_secret.url.secret_id
  description = "The name of the secret that holds the connection URL. A service mounts it by this name."
}

output "console_url" {
  value       = "https://console.cloud.google.com/sql/instances/${google_sql_database_instance.this.name}/overview?project=${var.project}"
  description = "Where the instance is in the console."
}
