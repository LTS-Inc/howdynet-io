# howdynet-io

Terraform source of truth for the Cloudflare zone **howdynet.io** (account LTS-Inc).

This repo exists to resolve the findings in Cloudflare's **Security Insights** dashboard as
reviewable code. The website itself is a Cloudflare Pages deployment and is not in this repo.

## What is managed

| Security Insight | Resource | File |
|---|---|---|
| Review unwanted AI crawlers with AI Labyrinth | `cloudflare_bot_management` (`crawler_protection`, `ai_bots_protection`) | `terraform/bots.tf` |
| Security.txt not configured | Cloudflare native security.txt (API via `terraform_data`) + Access bypass app on the apex path | `terraform/security_txt.tf`, `terraform/access.tf` |
| Bot Fight Mode not enabled | `cloudflare_bot_management` (`fight_mode`) | `terraform/bots.tf` |
| DMARC Record Error detected | `cloudflare_dns_record` for `_dmarc` (`p=quarantine`) | `terraform/dns_email.tf` |
| Domains without HSTS (apex and www) | `cloudflare_zone_setting` `security_header` | `terraform/security_headers.tf` |
| No Turnstile enabled | `cloudflare_turnstile_widget` | `terraform/turnstile.tf` |
| Users without MFA | `cloudflare_account` (`enforce_twofactor`) plus a manual step | `terraform/account.tf` |

**Deliberately not managed:** the A records for `@` and `www`, MX, SPF, DKIM and
`google-site-verification` TXT records, and the existing Zero Trust Access application that
protects the apex. None of the findings touch them, and importing them adds risk without benefit.
Change those in the dashboard.

## Manual pre-steps (once, before the first apply)

1. **Enable 2FA on your own Cloudflare user** (My Profile > Authentication). Every account
   member must do this *before* `enforce_twofactor` is applied, or they are locked out.
2. **Enable DMARC Management** (Email > DMARC Management) for howdynet.io. Cloudflare appends
   its own `rua` address to the `_dmarc` record. Copy that address into the `DMARC_RECORD`
   value below so Terraform and Cloudflare agree on the record.
3. **Create the R2 state bucket** `howdynet-io-tfstate` (R2 > Create bucket) and an R2 API
   token (R2 > Manage R2 API Tokens) with **Object Read & Write** on that bucket only.
4. **Create a Cloudflare API token** (My Profile > API Tokens > Create Custom Token):
   - Zone `howdynet.io`: Zone:Read, Zone Settings:Edit, DNS:Edit, Bot Management:Edit,
     Access: Apps and Policies:Edit
   - Account: Account Settings:Edit, Turnstile:Edit, Access: Apps and Policies:Edit
   - If the security.txt API call returns 403, add Zone WAF:Edit.
5. **Configure GitHub** (Settings > Secrets and variables > Actions):
   - Secrets: `CLOUDFLARE_API_TOKEN`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`
   - Variables: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCOUNT_NAME` (exact current account
     name), `DMARC_RECORD` (full TXT content, see `terraform/terraform.tfvars.example`)
   - Environment `production` with a required reviewer (gates `terraform apply`).

## Running locally

```sh
cd terraform
cp terraform.tfvars.example terraform.tfvars   # fill in real values
cp backend.hcl.example backend.hcl             # fill in ACCOUNT_ID
export CLOUDFLARE_API_TOKEN=...
export AWS_ACCESS_KEY_ID=...    # R2 token
export AWS_SECRET_ACCESS_KEY=...

terraform init -backend-config=backend.hcl
terraform fmt -check -recursive
terraform validate
terraform plan -out=tfplan
```

The first plan must show **4 imports and 0 destroys**: `security_header`, bot management, the
`_dmarc` record and the account are adopted in place; the Access policy and application, the
Turnstile widget and the security.txt config are new. Read the `cloudflare_account` diff
carefully: `name` must match the current account name. Then `terraform apply tfplan`.

After the first successful apply, delete `terraform/imports.tf` in a follow-up PR.

## CI

`.github/workflows/terraform.yml` runs `fmt`, `validate` and `plan` on pull requests and posts
the plan as a PR comment. Pushes to `main` run `plan` and `apply` under the `production`
environment. A concurrency group keeps runs serial; the backend also uses the S3 lockfile
(`use_lockfile`). If R2 rejects the conditional write, set `use_lockfile=false` in the workflow
and `backend.hcl` and rely on the concurrency group.

## Verifying each finding

```sh
Z=<zone_id>; T=$CLOUDFLARE_API_TOKEN
# 1 and 3: AI Labyrinth, AI bot blocking, Bot Fight Mode
curl -s -H "Authorization: Bearer $T" "https://api.cloudflare.com/client/v4/zones/$Z/bot_management" | jq '.result | {fight_mode, ai_bots_protection, crawler_protection}'
# 2: security.txt on both hosts (200, text/plain, no Access redirect)
curl -si https://www.howdynet.io/.well-known/security.txt | head -5
curl -si https://howdynet.io/.well-known/security.txt | head -5
# 4: DMARC
curl -s -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=_dmarc.howdynet.io&type=TXT' | jq -r '.Answer[].data'
# 5 and 6: HSTS
curl -sI https://www.howdynet.io/ | grep -i strict-transport-security
# 7: Turnstile
terraform output turnstile_sitekey
```

Security Insights re-scans periodically; findings clear after the next scan. The apex HSTS
finding may persist because the Access login redirect is generated before zone headers apply.
If every real response carries HSTS and only that redirect lacks it, archive the finding.

## Decisions and follow-ups

- **DMARC** moves from `p=none` to `p=quarantine; pct=100`. SPF and DKIM already align for
  Google Workspace. After 4 to 6 weeks of clean aggregate reports, change to `p=reject`.
  SPF stays `~all`: DMARC does the enforcement, and `-all` breaks forwarded mail.
- **HSTS** starts at 6 months with `includeSubDomains`. Raise to one year and set `preload`
  once no HTTP-only subdomain can appear.
- **Bot Fight Mode** is zone-wide. It can challenge API clients, monitoring, and automation
  hitting the Access-protected apex. Disable `fight_mode` if that becomes a problem.
- **AI crawlers** are blocked and AI Labyrinth is on. Managed `robots.txt` is not enabled
  because `www.howdynet.io/robots.txt` currently returns the site's HTML page; fix that in
  the site deployment first.
- **Turnstile** is created but not yet enforced. The three forms on www.howdynet.io
  (`contact`, `custom-quote`, `network-results`) use Netlify Forms markup and post to `/`,
  which has no handler on Cloudflare Pages, so they do not deliver today. Follow-up in the
  site deployment: add a Pages Function that verifies `cf-turnstile-response` against
  `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `turnstile_secret`, then
  embed the widget using `turnstile_sitekey`.
- **security.txt** has no Terraform resource yet
  ([cloudflare/terraform-provider-cloudflare#5781](https://github.com/cloudflare/terraform-provider-cloudflare/issues/5781)),
  so it is set through the API from a `terraform_data` provisioner. Bump
  `security_txt_expires` yearly.
