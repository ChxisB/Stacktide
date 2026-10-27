output "bucket_name" {
  value       = aws_s3_bucket.this.bucket
  description = "The bucket's name."
}

output "console_url" {
  value       = "https://s3.console.aws.amazon.com/s3/buckets/${aws_s3_bucket.this.bucket}?region=${var.region}"
  description = "Where the bucket is in the console."
}
