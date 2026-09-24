output "zone_id" {
  value = local.zone_id
}

output "dmarc_record" {
  value = cloudflare_dns_record.dmarc.content
}

output "turnstile_sitekey" {
  description = "Public sitekey to embed in the site's forms."
  value       = cloudflare_turnstile_widget.site_forms.sitekey
}

output "turnstile_secret" {
  description = "Server-side secret for siteverify. Store it as a secret in the site's deployment."
  value       = cloudflare_turnstile_widget.site_forms.secret
  sensitive   = true
}

output "security_txt_access_app_id" {
  value = cloudflare_zero_trust_access_application.security_txt.id
}
