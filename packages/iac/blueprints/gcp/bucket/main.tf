locals {
  # A bucket's name is global. The project's hash makes it the same for every stack in the project and
  # unlikely to be taken. A service in this environment derives the same name from its `buckets` input.
  bucket_name = "${var.environment}-${var.name}-${substr(sha256(var.project), 0, 8)}"
}

resource "google_storage_bucket" "this" {
  name     = local.bucket_name
  location = var.region

  # Nobody can be granted public access to this bucket or its objects, by any role or any ACL.
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  # A bucket that still holds objects is not deleted. Emptying it is a decision of its own.
  force_destroy = false

  versioning {
    enabled = var.versioning
  }
}
