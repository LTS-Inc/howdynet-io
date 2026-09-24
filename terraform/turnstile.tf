# Finding 7: "No Turnstile enabled" (account level).
#
# Creating the widget clears the finding and yields a sitekey/secret. Enforcing it on the
# three forms on www.howdynet.io is a follow-up in the site's own deployment: those forms
# currently carry Netlify Forms markup and have no handler on Cloudflare Pages.
resource "cloudflare_turnstile_widget" "site_forms" {
  account_id = var.account_id
  name       = "${var.zone_name} site forms"
  domains    = [var.zone_name, "www.${var.zone_name}"]
  mode       = "managed"
}
