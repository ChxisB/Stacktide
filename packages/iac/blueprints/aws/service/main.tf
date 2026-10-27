data "aws_caller_identity" "current" {}

locals {
  id = "${var.environment}-${var.name}-service"
  # A load balancer's name is capped at 32 characters and may not start with "internal-", which an environment
  # could be called. The prefix settles the second; the parts' limits settle the first (3 + 12 + 1 + 12).
  short        = "lb-${var.environment}-${var.name}"
  network_name = "${var.environment}-${var.network}-network"

  # What other resources in the environment are called. These are the same formulas their own modules use.
  secret_ids   = { for d in var.databases : d => "${var.environment}-${d}-database-url" }
  bucket_names = { for b in var.buckets : b => "${var.environment}-${b}-${data.aws_caller_identity.current.account_id}" }

  # One database is DATABASE_URL; several are DATABASE_URL_<NAME>.
  database_env = {
    for d, secret in local.secret_ids :
    (length(var.databases) == 1 ? "DATABASE_URL" : "DATABASE_URL_${upper(replace(d, "-", "_"))}") => secret
  }
  bucket_env = { for b, bucket in local.bucket_names : "BUCKET_${upper(replace(b, "-", "_"))}" => bucket }

  image = var.image == "" ? "public.ecr.aws/nginx/nginx:stable" : var.image
  port  = var.image == "" ? 80 : var.port
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

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.this.id]
  }

  tags = { Tier = "public" }
}

resource "aws_ecr_repository" "this" {
  name                 = local.id
  image_tag_mutability = "IMMUTABLE"
  force_delete         = true # images are rebuilt from source; a teardown does not stop at them

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.id}"
  retention_in_days = 30
}

# Two identities. The execution role is the platform's: it pulls the image, writes the log stream and reads the
# secrets the container is given. The task role is the application's own, and holds only what the application
# does with the buckets it uses.
data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.id}-exec"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role" "task" {
  name               = "${local.id}-task"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "execution" {
  # The one call AWS lets nothing narrower than "*" be granted for.
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [aws_ecr_repository.this.arn]
  }

  statement {
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "pull-and-log"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# A secret's ARN ends in six random characters, so the name is followed by six single-character wildcards: it
# names exactly one secret and needs no lookup.
data "aws_iam_policy_document" "secret" {
  for_each = local.secret_ids

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["arn:aws:secretsmanager:${var.region}:${data.aws_caller_identity.current.account_id}:secret:${each.value}-??????"]
  }
}

resource "aws_iam_role_policy" "secret" {
  for_each = local.secret_ids

  name   = "secret-${each.key}"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.secret[each.key].json
}

data "aws_iam_policy_document" "bucket" {
  for_each = local.bucket_names

  statement {
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["arn:aws:s3:::${each.value}/*"]
  }

  statement {
    actions   = ["s3:ListBucket"]
    resources = ["arn:aws:s3:::${each.value}"]
  }
}

resource "aws_iam_role_policy" "bucket" {
  for_each = local.bucket_names

  name   = "bucket-${each.key}"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.bucket[each.key].json
}

# The load balancer takes HTTPS from the world only when `public` is on; otherwise from inside the VPC.
resource "aws_security_group" "alb" {
  name        = "${local.id}-alb"
  description = "Load balancer of ${local.id}"
  vpc_id      = data.aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_public" {
  count = var.public ? 1 : 0

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_ingress_rule" "alb_internal" {
  count = var.public ? 0 : 1

  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from inside the VPC"
  cidr_ipv4         = data.aws_vpc.this.cidr_block
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "alb" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the tasks"
  referenced_security_group_id = aws_security_group.task.id
  ip_protocol                  = "tcp"
  from_port                    = local.port
  to_port                      = local.port
}

# Tasks take traffic from the load balancer and from nothing else. They send out HTTPS (the image registry, the
# AWS APIs, and the internet by the NAT gateway) and the database port inside the VPC; other outbound ports
# are closed.
resource "aws_security_group" "task" {
  name        = "${local.id}-task"
  description = "Tasks of ${local.id}"
  vpc_id      = data.aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "task" {
  security_group_id            = aws_security_group.task.id
  description                  = "From the load balancer"
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = local.port
  to_port                      = local.port
}

resource "aws_vpc_security_group_egress_rule" "task_https" {
  security_group_id = aws_security_group.task.id
  description       = "HTTPS out"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "task_database" {
  security_group_id = aws_security_group.task.id
  description       = "PostgreSQL inside the VPC"
  cidr_ipv4         = data.aws_vpc.this.cidr_block
  ip_protocol       = "tcp"
  from_port         = 5432
  to_port           = 5432
}

resource "aws_lb" "this" {
  name               = local.short
  load_balancer_type = "application"
  internal           = !var.public
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public ? data.aws_subnets.public.ids : data.aws_subnets.private.ids

  drop_invalid_header_fields = true

  # A service keeps no data, so a teardown is allowed to delete it.
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "this" {
  name_prefix = substr(var.name, 0, 6)
  vpc_id      = data.aws_vpc.this.id
  port        = local.port
  protocol    = "HTTP"
  target_type = "ip"

  # Anything but a server error counts as up, so an application with no route at "/" is not killed for it.
  health_check {
    path    = "/"
    matcher = "200-499"
  }

  deregistration_delay = 30

  lifecycle {
    create_before_destroy = true
  }
}

# The only listener. Port 80 has none, not even a redirect: there is nothing to answer a plain-HTTP request.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}

resource "aws_ecs_cluster" "this" {
  name = local.id
}

resource "aws_ecs_task_definition" "this" {
  family                   = local.id
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name         = "app"
      image        = local.image
      essential    = true
      portMappings = [{ containerPort = local.port, protocol = "tcp" }]
      environment  = [for k, v in local.bucket_env : { name = k, value = v }]
      secrets      = [for k, v in local.database_env : { name = k, valueFrom = v }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "app"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "this" {
  name            = local.id
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  health_check_grace_period_seconds = 60

  network_configuration {
    subnets          = data.aws_subnets.private.ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = "app"
    container_port   = local.port
  }

  # A deploy that never becomes healthy is rolled back to the last one that did.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # A deploy (feature 36) registers a new task definition revision and points the service at it; a later apply must not
  # put the first one back. The task definition resource below is only the first revision.
  lifecycle {
    ignore_changes = [task_definition]
  }

  # Without these the service can stick in DRAINING on delete, or start before it may pull its image or read its secrets.
  depends_on = [
    aws_lb_listener.https,
    aws_iam_role_policy.execution,
    aws_iam_role_policy.secret,
    aws_iam_role_policy.bucket,
    aws_vpc_security_group_egress_rule.task_https,
  ]
}
