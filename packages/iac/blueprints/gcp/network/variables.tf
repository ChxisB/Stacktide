variable "environment" {
  type        = string
  description = "The environment this network belongs to, like staging."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) <= 12
    error_message = "environment must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "name" {
  type        = string
  description = "The network's name inside the environment, like main."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.name)) && length(var.name) <= 12
    error_message = "name must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "project" {
  type        = string
  description = "The GCP project id. Only the console link uses it; the provider block in the stack sets the project."
}

variable "region" {
  type        = string
  description = "The region of the subnet."
}

variable "cidr" {
  type        = string
  default     = "10.20.0.0/16"
  description = "The private IPv4 range of the subnet."

  validation {
    condition     = can(cidrhost(var.cidr, 0))
    error_message = "cidr must be an IPv4 range like 10.20.0.0/16."
  }
}
