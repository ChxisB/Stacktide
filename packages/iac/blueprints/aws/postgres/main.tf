locals {
  id           = "${var.environment}-${var.name}-postgres"
  network_name = "${var.environment}-${var.network}-network"

  # The name a service in this environment mounts. It is the same formula the service module uses.
  secret_id = "${var.environment}-${var.name}-database-url"
}

# The network stack applied first (depends_on in stack.yml). Its VPC and subnets are found by the tags that
# module sets.
data "aws_vpc" "this" {
  tags = { Name = local.network_name }
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.this.id]
  }

  tags = { Tier = "private" }
}

resource "aws_db_subnet_group" "this" {
  name       = local.id
  subnet_ids = data.aws_subnets.private.ids
}

# Nothing is allowed in or out but the database port, from inside the VPC. A security group with no egress rule
# sends nothing out: a database needs no outbound connection.
resource "aws_security_group" "database" {
  name        = local.id
  description = "Reaches ${local.id} from inside the VPC on the database port only"
  vpc_id      = data.aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "database" {
  security_group_id = aws_security_group.database.id
  description       = "PostgreSQL from inside the VPC"
  cidr_ipv4         = data.aws_vpc.this.cidr_block
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
}

# The same switch as Cloud SQL's ssl_mode: a connection without TLS is refused.
resource "aws_db_parameter_group" "this" {
  name   = local.id
  family = "postgres${var.postgres_version}"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
}

# Kept for the final snapshot's name, so a database torn down twice does not collide with its own snapshot.
resource "random_id" "suffix" {
  byte_length = 3
}

resource "random_password" "database" {
  length  = 32
  special = false
}

resource "aws_db_instance" "this" {
  identifier     = local.id
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.instance_class

  db_name  = "app"
  username = "app"
  password = random_password.database.result

  storage_type          = "gp3"
  allocated_storage     = var.storage_gb
  max_allocated_storage = var.storage_gb * 4
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  publicly_accessible    = false

  backup_retention_period   = 7
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.id}-final-${random_id.suffix.hex}"

  # To remove the database, turn this off in a reviewed change first.
  deletion_protection = true
}

# Created and deleted with the stack: a recovery window would block making the same environment again for 30 days.
resource "aws_secretsmanager_secret" "url" {
  name                    = local.secret_id
  recovery_window_in_days = 0
}

# The one place the connection string is written. The password is also in this stack's state, which the
# platform keeps sealed (ADR-0017); it is in no output.
resource "aws_secretsmanager_secret_version" "url" {
  secret_id     = aws_secretsmanager_secret.url.id
  secret_string = "postgres://app:${random_password.database.result}@${aws_db_instance.this.address}:5432/app?sslmode=require"
}
