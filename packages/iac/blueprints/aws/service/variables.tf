variable "environment" {
  type        = string
  description = "The environment this service belongs to, like staging."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.environment)) && length(var.environment) <= 12
    error_message = "environment must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "name" {
  type        = string
  description = "The service's name inside the environment, like api."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.name)) && length(var.name) <= 12
    error_message = "name must be lowercase words joined by single dashes, at most 12 characters."
  }
}

variable "region" {
  type        = string
  description = "The region. Secret and log ARNs are built from it; the provider block in the stack sets the region."
}

variable "network" {
  type        = string
  description = "The name of a network resource in this environment (like main). The tasks run in its private subnets and the load balancer in its public ones, or its private ones when the service is not public."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*$", var.network)) && length(var.network) <= 12
    error_message = "network must be the name of a network resource in this environment."
  }
}

variable "certificate_arn" {
  type        = string
  description = "An ACM certificate in this region for the load balancer's HTTPS listener. The load balancer serves HTTPS and nothing else."
}

variable "image" {
  type        = string
  default     = ""
  description = "The container image. Empty runs a placeholder web server on port 80 until an image is set."
}

variable "port" {
  type        = number
  default     = 8080
  description = "The port the container listens on (the placeholder image always uses 80)."
}

variable "public" {
  type        = bool
  default     = false
  description = "Takes traffic from the internet. Off: the load balancer is internal and only callers inside the VPC can reach it."
}

variable "cpu" {
  type        = number
  default     = 256
  description = "CPU units of a task (1024 is one vCPU), from the profile. With memory it must be a Fargate pair."
}

variable "memory" {
  type        = number
  default     = 512
  description = "Memory of a task in MiB, from the profile."
}

variable "desired_count" {
  type        = number
  default     = 1
  description = "Tasks kept running, from the profile. Fargate does not scale to zero here."
}

variable "databases" {
  type        = list(string)
  default     = []
  description = "Names of the postgres resources in this environment the service uses. Each one's connection URL secret is injected."
}

variable "buckets" {
  type        = list(string)
  default     = []
  description = "Names of the bucket resources in this environment the service uses. Each one's name is set in the environment and the service may read and write its objects."
}
