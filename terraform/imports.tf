# First-apply adoption of objects that already exist in the zone/account so nothing is
# destroyed or duplicated. Delete this file in the PR after the first successful apply.
import {
  to = cloudflare_zone_setting.hsts
  id = "${local.zone_id}/security_header"
}

import {
  to = cloudflare_bot_management.zone
  id = local.zone_id
}

import {
  to = cloudflare_dns_record.dmarc
  id = "${local.zone_id}/${data.cloudflare_dns_records.dmarc_existing.result[0].id}"
}

import {
  to = cloudflare_account.this
  id = var.account_id
}
