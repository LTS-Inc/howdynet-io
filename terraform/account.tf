# Finding 8: "Users without MFA".
#
# Every member must have 2FA enabled on their own user BEFORE this is applied, or they are
# locked out of the account. See README "Manual pre-steps".
resource "cloudflare_account" "this" {
  name = var.account_name
  settings = {
    enforce_twofactor = true
  }

  lifecycle {
    prevent_destroy = true
  }
}
