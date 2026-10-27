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

variable "region" {
  type        = string
  description = "The region. Only the console link uses it; the provider block in the stack sets the region."
}

variable "cidr" {
  type        = string
  default     = "10.20.0.0/16"
  description = "The private IPv4 range of the VPC, from /16 to /24. It is cut into four subnets."

  validation {
    condition     = can(cidrhost(var.cidr, 0)) && tonumber(split("/", var.cidr)[1]) >= 16 && tonumber(split("/", var.cidr)[1]) <= 24
    error_message = "cidr must be an IPv4 range from /16 to /24, like 10.20.0.0/16."
  }
}
