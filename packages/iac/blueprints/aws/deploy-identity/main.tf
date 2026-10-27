data "aws_caller_identity" "current" {}

locals {
  id      = "${var.environment}-${var.name}-deploy"
  account = data.aws_caller_identity.current.account_id

  # What the service resource is called. These are the same formulas its own module uses: its cluster, service,
  # image repository and task definition share one name, and its two roles add -exec and -task.
  service_id = "${var.environment}-${var.service}-service"

  github      = var.forge == "github"
  owner       = split("/", var.repository)[0]
  repo        = split("/", var.repository)[1]
  issuer_host = local.github ? "token.actions.githubusercontent.com" : "gitlab.com"

  # The one subject the forge's token carries. A GitHub job that names an environment has the environment form
  # (the deploy workflow does); GitLab's subject has the branch and never the environment.
  subject = local.github ? (
    var.immutable_subject
    ? "repo:${local.owner}@${var.owner_id}/${local.repo}@${var.repository_id}:environment:${var.environment}"
    : "repo:${var.repository}:environment:${var.environment}"
  ) : "project_path:${var.repository}:ref_type:branch:ref:${var.branch}"

  provider_arn = var.existing_oidc_provider ? data.aws_iam_openid_connect_provider.existing[0].arn : aws_iam_openid_connect_provider.this[0].arn
}

# An account has one provider for an issuer. The first identity makes it; later ones set `existing_oidc_provider`.
# Destroying the identity that made it removes the provider the others use.
resource "aws_iam_openid_connect_provider" "this" {
  count = var.existing_oidc_provider ? 0 : 1

  url            = "https://${local.issuer_host}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "existing" {
  count = var.existing_oidc_provider ? 1 : 0

  url = "https://${local.issuer_host}"
}

# Exact matches only. `StringLike` and a wildcard in the subject are the docs' own examples and are refused here.
data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.issuer_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.issuer_host}:sub"
      values   = [local.subject]
    }

    # gitlab.com's provider also takes the numeric ids as condition keys, so a renamed or recreated project cannot match.
    # GitHub's ids are not documented as condition keys: there they travel in the immutable subject.
    dynamic "condition" {
      for_each = local.github ? {} : {
        project_id   = var.repository_id
        namespace_id = var.owner_id
      }

      content {
        test     = "StringEquals"
        variable = "${local.issuer_host}:${condition.key}"
        values   = [tostring(condition.value)]
      }
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = local.id
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

# What a deploy does (scripts/deploy-ecs.sh): sign in to the registry, check for and push the image, copy the task
# definition with the new image, update the service and wait. Two of the statements name `*` because AWS gives
# those calls no narrower resource: the registry login, and registering and reading a task definition (the ECS
# action table could not be read, so this is the safe reading; the first real deploy shows if the cloud agrees).
data "aws_iam_policy_document" "deploy" {
  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = ["arn:aws:ecr:${var.region}:${local.account}:repository/${local.service_id}"]
  }

  statement {
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = ["arn:aws:ecs:${var.region}:${local.account}:service/${local.service_id}/${local.service_id}"]
  }

  statement {
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  # A new task definition names the service's two roles. This lets the deploy pass those two to ECS and no others.
  statement {
    actions = ["iam:PassRole"]
    resources = [
      "arn:aws:iam::${local.account}:role/${local.service_id}-exec",
      "arn:aws:iam::${local.account}:role/${local.service_id}-task",
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.deploy.json
}
