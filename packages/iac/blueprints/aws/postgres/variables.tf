variable "environment" {
  type        = string
  description = "The environment this database belongs to, like staging."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) <= 12
    error_message = "environment must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "name" {
  type        = string
  description = "The database's name inside the environment, like main."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.name)) && length(var.name) <= 12
    error_message = "name must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "region" {
  type        = string
  description = "The region. Only the console link uses it; the provider block in the stack sets the region."
}

variable "network" {
  type        = string
  description = "The name of a network resource in this environment (like main). The instance sits in its private subnets and takes traffic from inside its VPC only."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.network)) && length(var.network) <= 12
    error_message = "network must be the name of a network resource in this environment."
  }
}

variable "postgres_version" {
  type        = string
  default     = "16"
  description = "The major version of PostgreSQL."

  validation {
    condition     = contains(["15", "16", "17"], var.postgres_version)
    error_message = "postgres_version must be 15, 16 or 17."
  }
}

variable "instance_class" {
  type        = string
  default     = "db.t4g.micro"
  description = "The instance class, from the profile."
}

variable "storage_gb" {
  type        = number
  default     = 20
  description = "The starting disk size in GB, from the profile. The disk grows by itself, to four times this, and never shrinks."
}
