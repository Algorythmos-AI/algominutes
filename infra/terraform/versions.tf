# AlgoMinutes — Terraform + provider version constraints.
# Shared by every environment via a symlink-free copy is unnecessary: root
# modules under envs/* set their own `terraform`/`required_providers` blocks
# that mirror this file. This top-level file documents the canonical versions
# and is the single source of truth to bump.

terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
