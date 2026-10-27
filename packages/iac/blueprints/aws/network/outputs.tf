output "vpc_id" {
  value       = aws_vpc.this.id
  description = "Other resources in the environment look the VPC up by its Name tag, not by this id."
}

output "private_subnet_ids" {
  value       = aws_subnet.private[*].id
  description = "The subnets for tasks and databases (tag Tier = private)."
}

output "public_subnet_ids" {
  value       = aws_subnet.public[*].id
  description = "The subnets for a load balancer (tag Tier = public)."
}

output "console_url" {
  value       = "https://${var.region}.console.aws.amazon.com/vpcconsole/home?region=${var.region}#VpcDetails:VpcId=${aws_vpc.this.id}"
  description = "Where the VPC is in the console."
}
