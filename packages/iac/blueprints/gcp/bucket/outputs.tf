output "bucket_name" {
  value       = google_storage_bucket.this.name
  description = "The bucket's name."
}

output "console_url" {
  value       = "https://console.cloud.google.com/storage/browser/${google_storage_bucket.this.name}?project=${var.project}"
  description = "Where the bucket is in the console."
}
