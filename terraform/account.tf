# Finding 8: "Users without MFA".
#
# Every member must have 2FA enabled on their own user BEFORE this is applied, or they are
# locked out of the account. `howdy up` checks the current user via the API and only enables
# var.enforce_2fa once that is true.
resource "cloudflare_account" "this" {
  count = var.enforce_2fa ? 1 : 0

  name = var.account_name
  settings = {
    enforce_twofactor = true
  }

  lifecycle {
    prevent_destroy = true
  }
}
