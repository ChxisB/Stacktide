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

variable "project" {
  type        = string
  description = "The GCP project id. The provider block in the stack sets the project; the module needs it for the console link."
}

variable "region" {
  type        = string
  description = "The region of the instance. It must be the region of the network's subnet."
}

variable "network" {
  type        = string
  description = "The name of a network resource in this environment (like main). The instance has a private address on it and no other."

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

variable "tier" {
  type        = string
  default     = "db-f1-micro"
  description = "The machine type, from the profile."
}

variable "storage_gb" {
  type        = number
  default     = 10
  description = "The starting disk size in GB, from the profile. The disk grows by itself and never shrinks."
}
