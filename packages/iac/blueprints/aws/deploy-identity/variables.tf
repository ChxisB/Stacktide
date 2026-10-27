variable "environment" {
  type        = string
  description = "The environment of the service this identity deploys, like staging. A GitHub deploy job names it as its environment."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) <= 12
    error_message = "environment must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "name" {
  type        = string
  description = "The identity's name inside the environment, like web."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.name)) && length(var.name) <= 12
    error_message = "name must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "region" {
  type        = string
  description = "The region of the service and of its image repository. The provider block in the stack sets the region."
}

variable "service" {
  type        = string
  description = "The name of the service resource in this environment (like web) that this identity may deploy, and the image repository it may push to."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.service)) && length(var.service) <= 12
    error_message = "service must be the name of a service resource in this environment."
  }
}

variable "forge" {
  type        = string
  description = "Where the deploy runs: github (github.com) or gitlab (gitlab.com)."

  validation {
    condition     = contains(["github", "gitlab"], var.forge)
    error_message = "forge must be github or gitlab."
  }
}

variable "repository" {
  type        = string
  description = "owner/repository on GitHub, group/subgroup/project on GitLab. The one repository this identity trusts."

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$", var.repository))
    error_message = "repository must be a path of names without a colon, an at sign or a percent."
  }
}

variable "repository_id" {
  type        = number
  description = "GitHub's repository_id or GitLab's project_id. GitLab's provider takes it as a condition key; GitHub's reaches the trust through the immutable subject."
}

variable "owner_id" {
  type        = number
  description = "GitHub's repository_owner_id or GitLab's namespace_id."
}

variable "branch" {
  type        = string
  default     = ""
  description = "GitLab only: the branch whose pipelines may deploy. GitHub's subject names the environment, so it is empty there."
}

variable "immutable_subject" {
  type        = bool
  default     = false
  description = "GitHub only: the repository's subject carries ids (repositories created after 2026-07-15, or opted in)."
}

variable "existing_oidc_provider" {
  type        = bool
  default     = false
  description = "An account has one OIDC provider for an issuer. Set when another stack already made the forge's: it is looked up instead of created."
}
