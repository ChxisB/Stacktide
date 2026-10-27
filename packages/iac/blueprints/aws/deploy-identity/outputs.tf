output "console_url" {
  value       = "https://${var.region}.console.aws.amazon.com/iam/home?region=${var.region}#/roles/details/${aws_iam_role.this.name}"
  description = "Where the deploy role is in the console."
}

output "role_name" {
  value       = aws_iam_role.this.name
  description = "The role the deploy assumes: the deploy template's `role` value."
}

output "role_arn" {
  value       = aws_iam_role.this.arn
  description = "The role's ARN."
}
