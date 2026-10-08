# Bare-domain redirect: howdynet.io/* -> https://www.howdynet.io/*
#
# The apex hosted the internal Multi-Frames portal behind a Zero Trust Access app, so
# visitors who typed the domain without "www" hit a login page. `howdy apex` first moves
# that portal and its Access app to multi-frame.howdynet.io, then enables this rule.
# Single Redirects run at the edge before the request reaches any origin, so the apex DNS
# record can keep pointing wherever it points today.
resource "cloudflare_ruleset" "apex_redirect" {
  count = var.apex_redirect ? 1 : 0

  zone_id     = local.zone_id
  name        = "Redirect bare domain to www"
  description = "Managed by Terraform (LTS-Inc/howdynet-io)"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [
    {
      description = "howdynet.io -> www.howdynet.io, same path and query"
      expression  = "(http.host eq \"${var.zone_name}\")"
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code           = 301
          preserve_query_string = true
          target_url = {
            expression = "concat(\"https://www.${var.zone_name}\", http.request.uri.path)"
          }
        }
      }
    }
  ]
}
