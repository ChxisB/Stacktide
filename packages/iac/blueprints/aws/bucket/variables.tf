variable "environment" {
  type        = string
  description = "The environment this bucket belongs to, like staging."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) <= 12
    error_message = "environment must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "name" {
  type        = string
  description = "The bucket's name inside the environment, like files."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.name)) && length(var.name) <= 12
    error_message = "name must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "region" {
  type        = string
  description = "The region. Only the console link uses it; the provider block in the stack sets the region."
}

variable "versioning" {
  type        = bool
  default     = false
  description = "Keep older versions of an object when it is overwritten or deleted."
}
