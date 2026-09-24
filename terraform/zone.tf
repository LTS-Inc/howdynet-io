data "cloudflare_zone" "this" {
  filter = {
    name = var.zone_name
    account = {
      id = var.account_id
    }
  }
}

locals {
  zone_id = data.cloudflare_zone.this.id
}
