terraform {
  required_version = ">= 1.8.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.22"
    }
  }
}

provider "cloudflare" {}

variable "account_id" {
  type        = string
  description = "Cloudflare account ID."
}

variable "application_domain" {
  type        = string
  description = "Hostname protected by Access, without a scheme."
}

variable "allowed_email" {
  type        = string
  description = "Email address allowed to use wr."
}

variable "access_team_domain" {
  type        = string
  description = "Existing Cloudflare Access team domain configured in the dashboard."
}

resource "cloudflare_zero_trust_access_application" "wr" {
  account_id           = var.account_id
  name                 = "wr"
  domain               = var.application_domain
  type                 = "self_hosted"
  session_duration     = "24h"
  app_launcher_visible = false

  policies = [{
    name       = "Allow wr user"
    decision   = "allow"
    precedence = 1
    include = [{
      email = {
        email = var.allowed_email
      }
    }]
  }]

  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allow_any_on_localhost = true
      allow_any_on_loopback  = true
    }
    grant = {
      access_token_lifetime = "15m"
      session_duration      = "336h"
    }
  }
}

output "wrangler_vars" {
  description = "Values for ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.jsonc."
  value = {
    ACCESS_TEAM_DOMAIN = var.access_team_domain
    ACCESS_AUD         = cloudflare_zero_trust_access_application.wr.aud
  }
}
