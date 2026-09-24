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
