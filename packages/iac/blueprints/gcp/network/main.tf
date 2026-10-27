locals {
  # The stack's name. A service or database in the same environment finds the network by this name.
  id = "${var.environment}-${var.name}-network"
}

resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "servicenetworking" {
  service            = "servicenetworking.googleapis.com"
  disable_on_destroy = false
}

# A custom-mode network has no subnets and no firewall rule of its own: nothing reaches it from outside,
# and this module adds no rule that would let anything in.
resource "google_compute_network" "this" {
  name                    = local.id
  auto_create_subnetworks = false

  depends_on = [google_project_service.compute]
}

# One subnet, with the same name as the network. Cloud Run's direct VPC egress and Cloud SQL's private
# address both live here, so neither needs a public address.
resource "google_compute_subnetwork" "this" {
  name                     = local.id
  region                   = var.region
  network                  = google_compute_network.this.id
  ip_cidr_range            = var.cidr
  private_ip_google_access = true
}

# Private service access: the range Cloud SQL takes its private address from.
resource "google_compute_global_address" "private_services" {
  name          = "${local.id}-services"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.this.id
}

resource "google_service_networking_connection" "private_services" {
  network                 = google_compute_network.this.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_services.name]

  depends_on = [google_project_service.servicenetworking]
}
