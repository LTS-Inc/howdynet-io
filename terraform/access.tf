# The apex howdynet.io is protected by an existing Zero Trust Access application, which
# would redirect /.well-known/security.txt to a login page. A narrower application
# scoped to exactly that path with a Bypass policy makes the file public. Access picks
# the most specific matching path, so the existing apex application is left untouched.
resource "cloudflare_zero_trust_access_policy" "security_txt_bypass" {
  account_id = var.account_id
  name       = "Public security.txt (bypass)"
  decision   = "bypass"
  include = [
    { everyone = {} }
  ]
}

resource "cloudflare_zero_trust_access_application" "security_txt" {
  account_id           = var.account_id
  type                 = "self_hosted"
  name                 = "${var.zone_name} security.txt (public)"
  domain               = "${var.zone_name}/.well-known/security.txt"
  app_launcher_visible = false
  destinations = [
    {
      type = "public"
      uri  = "${var.zone_name}/.well-known/security.txt"
    }
  ]
  policies = [
    {
      id         = cloudflare_zero_trust_access_policy.security_txt_bypass.id
      precedence = 1
    }
  ]
}
