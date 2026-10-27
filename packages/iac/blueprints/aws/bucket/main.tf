data "aws_caller_identity" "current" {}

locals {
  # A bucket's name is global. The account id makes it the same for every stack in the account and unlikely to
  # be taken. A service in this environment derives the same name from its `buckets` input.
  bucket_name = "${var.environment}-${var.name}-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "this" {
  bucket = local.bucket_name

  # A bucket that still holds objects is not deleted. Emptying it is a decision of its own.
  force_destroy = false
}

# All four on: no ACL and no bucket policy can make this bucket or an object in it public.
resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# No resource when it is off: an unversioned bucket is S3's default, and removing this resource later suspends
# versioning (it does not delete the versions already kept).
resource "aws_s3_bucket_versioning" "this" {
  count = var.versioning ? 1 : 0

  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}
