# Finding 4: "DMARC Record Error detected".
#
# Only the _dmarc record is managed here. MX, SPF, DKIM, site-verification and the
# A records for @ and www are intentionally left unmanaged (see README).
resource "cloudflare_dns_record" "dmarc" {
  zone_id = local.zone_id
  name    = "_dmarc.${var.zone_name}"
  type    = "TXT"
  ttl     = 1 # auto
  content = var.dmarc_record
  comment = "Managed by Terraform (LTS-Inc/howdynet-io)"
}

# Existing _dmarc record, used only by the import block in imports.tf.
data "cloudflare_dns_records" "dmarc_existing" {
  zone_id = local.zone_id
  type    = "TXT"
  name = {
    exact = "_dmarc.${var.zone_name}"
  }
}
