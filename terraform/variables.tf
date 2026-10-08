variable "account_id" {
  description = "Cloudflare account ID that owns the howdynet.io zone."
  type        = string
}

variable "account_name" {
  description = "Current display name of the Cloudflare account. Must match exactly or Terraform will rename the account."
  type        = string
}

variable "zone_name" {
  description = "Zone name."
  type        = string
  default     = "howdynet.io"
}

variable "dmarc_record" {
  description = "Full DMARC TXT content. Add the Cloudflare DMARC Management rua address once enabled in the dashboard."
  type        = string
  default     = "v=DMARC1; p=quarantine; pct=100; rua=mailto:postmaster@howdynet.io; fo=1"
}

variable "hsts_max_age" {
  description = "HSTS max-age in seconds. 6 months to start; raise to 31536000 before enabling preload."
  type        = number
  default     = 15552000
}

variable "hsts_include_subdomains" {
  description = "Apply HSTS to all subdomains. Only apex and www serve HTTP today; confirm no unproxied HTTP subdomain exists before enabling."
  type        = bool
  default     = true
}

variable "hsts_preload" {
  description = "Signal HSTS preload list eligibility. Keep false until max-age is >= 1 year and includeSubDomains is proven safe."
  type        = bool
  default     = false
}

variable "security_txt_contact" {
  description = "Contact URI(s) published in security.txt."
  type        = list(string)
  default     = ["mailto:support@howdynet.io"]
}

variable "security_txt_expires" {
  description = "RFC 3339 expiry for security.txt. Must be less than one year out; bump it on a yearly cadence."
  type        = string
  default     = "2027-09-01T00:00:00Z"
}

variable "enable_extra_headers" {
  description = "Also set Permissions-Policy and X-Frame-Options via a response header transform rule."
  type        = bool
  default     = false
}

variable "enforce_2fa" {
  description = "Manage the account and enforce 2FA for all members. Only set true once every member (including you) has 2FA enabled; `howdy` sets it automatically."
  type        = bool
  default     = false
}

variable "apex_redirect" {
  description = "Redirect the bare domain to www. Enable only after the internal portal and its Access app have moved off the apex (`howdy apex` does both)."
  type        = bool
  default     = false
}

variable "admin_access" {
  description = "Create the Google identity provider and Access application for www/admin. `howdy admin` turns this on once it has the Google OAuth client."
  type        = bool
  default     = false
}

variable "google_client_id" {
  description = "OAuth client ID of the Google Cloud credential used for Access sign-in on /admin."
  type        = string
  default     = ""
}

variable "google_client_secret" {
  description = "OAuth client secret for the Google credential above."
  type        = string
  default     = ""
  sensitive   = true
}

variable "admin_emails" {
  description = "Google accounts allowed to open www/admin."
  type        = list(string)
  default     = ["support@howdynet.io"]
}
