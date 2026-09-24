# Finding 2: "Security.txt not configured".
#
# Cloudflare serves /.well-known/security.txt natively once the zone's Security Center
# security.txt config is enabled. The Terraform provider has no resource for it yet
# (cloudflare/terraform-provider-cloudflare#5781), so the API is called from a
# local-exec provisioner. There is no drift detection: changing local.security_txt
# re-runs the PUT. Migrate to the native resource when it ships.
locals {
  security_txt = {
    enabled             = true
    contact             = var.security_txt_contact
    expires             = var.security_txt_expires
    canonical           = ["https://www.${var.zone_name}/.well-known/security.txt"]
    preferred_languages = "en"
  }
}

resource "terraform_data" "security_txt" {
  input            = local.security_txt
  triggers_replace = [jsonencode(local.security_txt), local.zone_id]

  provisioner "local-exec" {
    interpreter = ["/bin/sh", "-c"]
    command     = <<-EOT
      curl -fsS -X PUT "https://api.cloudflare.com/client/v4/zones/${local.zone_id}/security-center/securitytxt" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        -H "Content-Type: application/json" \
        --data '${jsonencode(local.security_txt)}'
    EOT
  }

  provisioner "local-exec" {
    when        = destroy
    interpreter = ["/bin/sh", "-c"]
    command     = <<-EOT
      curl -fsS -X DELETE "https://api.cloudflare.com/client/v4/zones/${self.triggers_replace[1]}/security-center/securitytxt" \
        -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
    EOT
  }
}
