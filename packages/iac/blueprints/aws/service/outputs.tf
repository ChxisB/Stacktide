output "url" {
  value       = "https://${aws_lb.this.dns_name}"
  description = "The load balancer's address. Point a name covered by the certificate at it; reachable from the internet only when public is on."
}

output "console_url" {
  value       = "https://${var.region}.console.aws.amazon.com/ecs/v2/clusters/${aws_ecs_cluster.this.name}/services/${aws_ecs_service.this.name}?region=${var.region}"
  description = "Where the service is in the console."
}

output "repository" {
  value       = aws_ecr_repository.this.repository_url
  description = "Where this service's images are pushed (feature 36 deploys from here)."
}

output "task_role" {
  value       = aws_iam_role.task.arn
  description = "The identity the application runs as."
}
