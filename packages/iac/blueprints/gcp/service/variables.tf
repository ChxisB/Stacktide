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

variable "project" {
  type        = string
  description = "The GCP project id. The provider block in the stack sets the project; the module needs it for names it derives."
}

variable "region" {
  type        = string
  description = "The region of the service and of its image repository."
}

variable "image" {
  type        = string
  default     = ""
  description = "The container image. Empty runs Google's hello image until the first deploy sets a real one."
}

variable "port" {
  type        = number
  default     = 8080
  description = "The port the container listens on (the hello image always uses 8080)."
}

variable "public" {
  type        = bool
  default     = false
  description = "Takes traffic from the internet without a login. Off: only callers inside the project's network, with permission, can reach it."
}

variable "cpu" {
  type        = string
  default     = "1"
  description = "CPU limit of an instance, from the profile."
}

variable "memory" {
  type        = string
  default     = "512Mi"
  description = "Memory limit of an instance, from the profile."
}

variable "min_instances" {
  type        = number
  default     = 0
  description = "Instances kept running when idle, from the profile. Zero scales to nothing."
}

variable "max_instances" {
  type        = number
  default     = 3
  description = "Most instances the service scales to, from the profile."
}

variable "network" {
  type        = string
  default     = ""
  description = "The name of a network resource in this environment (like main) to send outbound traffic through. Empty: no network."
}

variable "databases" {
  type        = list(string)
  default     = []
  description = "Names of the postgres resources in this environment the service uses. Each one's connection URL secret is mounted."
}

variable "buckets" {
  type        = list(string)
  default     = []
  description = "Names of the bucket resources in this environment the service uses. Each one's name is set in the environment and the service may read and write its objects."
}
