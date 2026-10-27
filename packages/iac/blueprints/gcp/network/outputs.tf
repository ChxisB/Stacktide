output "network_name" {
  value       = google_compute_network.this.name
  description = "Other resources in the environment look the network up by this name."
}

output "subnetwork_name" {
  value       = google_compute_subnetwork.this.name
  description = "The subnet, in the module's region."
}

output "console_url" {
  value       = "https://console.cloud.google.com/networking/networks/details/${google_compute_network.this.name}?project=${var.project}"
  description = "Where the network is in the console."
}
