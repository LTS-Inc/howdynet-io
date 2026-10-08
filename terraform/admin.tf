# Cloudflare Access in front of the site's admin page (www.howdynet.io/admin).
#
# Sign-in is Google only, and only the addresses in var.admin_emails are allowed (support@howdynet.io
# by default). The Worker also verifies the Access JWT itself (site/src/lib/access.ts), using the
# application AUD exported below; `howdy admin` writes that AUD into site/wrangler.jsonc.
#
# The Google OAuth client is the one manual step: Google Cloud Console > APIs & Services >
# Credentials > Create credentials > OAuth client ID > Web application, with the redirect URI
# https://<team>.cloudflareaccess.com/cdn-cgi/access/callback. `howdy admin` prompts for it.

resource "cloudflare_zero_trust_access_identity_provider" "google" {
  count      = var.admin_access ? 1 : 0
  account_id = var.account_id
  name       = "Google (site admin)"
  type       = "google"
  config = {
    client_id     = var.google_client_id
    client_secret = var.google_client_secret
  }
}

resource "cloudflare_zero_trust_access_policy" "site_admin" {
  count      = var.admin_access ? 1 : 0
  account_id = var.account_id
  name       = "Site admin (allow listed emails)"
  decision   = "allow"
  include = [
    for e in var.admin_emails : { email = { email = e } }
  ]
}

resource "cloudflare_zero_trust_access_application" "site_admin" {
  count                     = var.admin_access ? 1 : 0
  account_id                = var.account_id
  type                      = "self_hosted"
  name                      = "www.${var.zone_name} admin"
  domain                    = "www.${var.zone_name}/admin"
  session_duration          = "24h"
  app_launcher_visible      = false
  auto_redirect_to_identity = true
  allowed_idps              = [cloudflare_zero_trust_access_identity_provider.google[0].id]
  destinations = [
    { type = "public", uri = "www.${var.zone_name}/admin" },
    { type = "public", uri = "www.${var.zone_name}/admin/*" },
    { type = "public", uri = "www.${var.zone_name}/api/admin/*" },
  ]
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.site_admin[0].id
      precedence = 1
    }
  ]
}
