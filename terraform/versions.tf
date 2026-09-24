terraform {
  required_version = ">= 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.25"
    }
  }

  # State lives in a Cloudflare R2 bucket via the S3-compatible backend.
  # All values are supplied with -backend-config (see README and backend.hcl.example).
  backend "s3" {}
}
