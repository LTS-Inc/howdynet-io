# Findings 5 and 6: "Domains without HSTS" for howdynet.io and www.howdynet.io.
# The security_header zone setting applies to every proxied hostname in the zone.
resource "cloudflare_zone_setting" "hsts" {
  zone_id    = local.zone_id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      max_age            = var.hsts_max_age
      include_subdomains = var.hsts_include_subdomains
      preload            = var.hsts_preload
      nosniff            = true
    }
  }
}

# Optional hardening headers. Off by default; no CSP is set because the www site is a
# single-page HTML with inline scripts and would need testing first.
resource "cloudflare_ruleset" "response_headers" {
  count = var.enable_extra_headers ? 1 : 0

  zone_id     = local.zone_id
  name        = "Security response headers"
  description = "Managed by Terraform (LTS-Inc/howdynet-io)"
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules = [
    {
      description = "Set baseline security headers"
      expression  = "true"
      action      = "rewrite"
      action_parameters = {
        headers = {
          "X-Frame-Options" = {
            operation = "set"
            value     = "SAMEORIGIN"
          }
          "Permissions-Policy" = {
            operation = "set"
            value     = "camera=(), microphone=(), geolocation=()"
          }
        }
      }
    }
  ]
}
