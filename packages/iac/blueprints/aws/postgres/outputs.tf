output "instance_name" {
  value       = aws_db_instance.this.identifier
  description = "The RDS instance's identifier."
}

output "secret_id" {
  value       = aws_secretsmanager_secret.url.name
  description = "The name of the secret that holds the connection URL. A service mounts it by this name."
}

output "console_url" {
  value       = "https://${var.region}.console.aws.amazon.com/rds/home?region=${var.region}#database:id=${aws_db_instance.this.identifier};is-cluster=false"
  description = "Where the instance is in the console."
}
