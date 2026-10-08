# Manual setup and operations (fallback)

`./howdy up` automates everything below. Use this only if you cannot run the CLI or want to understand each step.

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

**Deliberately not managed:** the A record for `@`, MX, SPF, DKIM and `google-site-verification`
TXT records, and the existing Zero Trust Access application that protects the apex. None of the
findings touch them, and importing them adds risk without benefit. Change those in the dashboard.
The `www` record is created and owned by the Worker's custom domain (see the website section);
never import it into Terraform.

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
     name), `ENFORCE_2FA` (`true` only after every member has 2FA), `DMARC_RECORD` (full TXT content, e.g. `v=DMARC1; p=quarantine; pct=100; rua=mailto:postmaster@howdynet.io; fo=1`)
   - Environment `production` with a required reviewer (gates `terraform apply`).

## Running locally

```sh
cd terraform
export CLOUDFLARE_API_TOKEN=...
export AWS_ACCESS_KEY_ID=...    # R2 token
export AWS_SECRET_ACCESS_KEY=...

terraform init \
  -backend-config=bucket=howdynet-io-tfstate -backend-config=key=howdynet-io/terraform.tfstate -backend-config=region=auto \
  -backend-config='endpoints={s3="https://<ACCOUNT_ID>.r2.cloudflarestorage.com"}' \
  -backend-config=skip_credentials_validation=true -backend-config=skip_region_validation=true \
  -backend-config=skip_requesting_account_id=true -backend-config=skip_metadata_api_check=true \
  -backend-config=skip_s3_checksum=true -backend-config=use_path_style=true -backend-config=use_lockfile=true
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
and in `bin/howdy.mjs` (backendArgs) and rely on the concurrency group.

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
- **AI crawlers** are blocked and AI Labyrinth is on. The site ships its own `robots.txt`
  (`site/public/robots.txt`); Cloudflare's managed robots.txt is left off to keep one owner.
- **Turnstile** is enforced by the website's form endpoint (`site/src/pages/api/form.ts`), which
  verifies `cf-turnstile-response` with `turnstile_secret`; the widget uses `turnstile_sitekey`.
- **security.txt** has no Terraform resource yet
  ([cloudflare/terraform-provider-cloudflare#5781](https://github.com/cloudflare/terraform-provider-cloudflare/issues/5781)),
  so it is set through the API from a `terraform_data` provisioner. Bump
  `security_txt_expires` yearly.

## Website (`site/`)

Astro 7 + `@astrojs/cloudflare`, deployed with wrangler to the Worker `howdynet-www`. The site is
a small multi-page site (`/`, `/internet`, `/managed-it`, `/plans`, `/ranchhand`, `/network-test`,
`/about`, `/privacy`, `/terms`) built from the approved redesign mocks. Pages render on the Worker
per request (`output: "server"`) so that copy, prices and images edited on `/admin` show up
without a rebuild; the legal pages and 404 are prerendered. Workers Static Assets serves
`dist/client`; `assets.run_worker_first` sends page navigations to the Worker and leaves
`/_astro`, `/img`, the favicon, robots and sitemaps to the asset layer.

- `src/lib/settings.ts` is the content model: defaults for everything editable, the KV key
  (`settings/site` in `FORM_SUBMISSIONS`), validation (`normalize`), a 30-second per-isolate
  cache and the form-to-settings mapping. `src/middleware.ts` loads it into `Astro.locals.settings`
  for every request and adds the security headers to Worker responses (`public/_headers` covers
  static assets only).
- `/admin` (`src/pages/admin/index.astro`, `src/pages/api/admin/settings.ts`) is protected twice:
  Cloudflare Access (Google IdP, `terraform/admin.tf`) in front of the path, and the Worker's own
  check of the `Cf-Access-Jwt-Assertion` token in `src/lib/access.ts` (RS256 against the team's
  JWKS, `aud` = `ACCESS_AUD`, email in `ADMIN_EMAILS`). Uploaded images live in KV under
  `media/<slot>` and are served by `src/pages/media/[slot].ts`.
- The four optional extras (hidden game, Konami code, floating hat, promo popup) live in
  `src/scripts/extras.js`; `Base.astro` includes it only when a flag is on, with the config in a
  JSON script tag. Pages carry no extra markup or CSS while they are off.
- Forms: one contact schema (`src/lib/forms.ts`) used by the short form on the home page, the full
  form on `/about` (`?need=` preselects the radio) and the results form on `/network-test`. The old
  `custom-quote` and `network-results` field names are still accepted and normalised. The endpoint
  (`src/pages/api/form.ts`) checks a honeypot, verifies Turnstile, stores every submission in KV
  and emails it to `support@howdynet.io`. Completed network tests are kept in `sessionStorage`
  (`howdynet.test`) and attached automatically on `/about`.
- `public/_redirects`: `/coverage` -> `/about#coverage`, `.html` URLs -> clean URLs. Old one-page
  anchors (`/#plans`, `/#free-diagnosis`, ...) forward to the new pages from an inline script on
  the home page.

### Local development

```sh
cd site
npm ci
cp .env.example .env            # PUBLIC_TURNSTILE_SITEKEY (test key by default)
cp .dev.vars.example .dev.vars  # TURNSTILE_SECRET (test secret by default); add ACCESS_DEV_BYPASS_EMAIL=support@howdynet.io to open /admin locally
npx wrangler types              # generates worker-configuration.d.ts (gitignored)
npm run check && npm run build
npm run preview                 # wrangler dev on the built bundle (dist/server/wrangler.json); email sends are simulated
```

Form endpoint smoke test (Astro's CSRF check requires a same-origin `Origin` header):

```sh
curl -s -X POST http://127.0.0.1:8787/api/form -H 'Origin: http://127.0.0.1:8787' -H 'Accept: application/json' \
  --data 'form-name=contact&cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX&name=Test+User&email=test@example.com&need=coverage'
npx wrangler kv key list --binding FORM_SUBMISSIONS --local
```

### One-time setup before the first deploy

1. **KV namespace:** `cd site && npx wrangler kv namespace create FORM_SUBMISSIONS`, paste the id
   into `wrangler.jsonc`.
2. **Email:** in the dashboard (Email > Email Routing) add and verify the destination address
   `support@howdynet.io`, then onboard the subdomain `mail.howdynet.io` as a sending domain so the
   Worker can send from `forms@mail.howdynet.io`. The apex keeps its Google Workspace MX and the
   Terraform-managed `_dmarc` record; only `mail.howdynet.io` records are added. Until this is
   done, submissions still land in KV and the endpoint still returns success.
3. **API token:** create a second token from the "Edit Cloudflare Workers" template scoped to the
   account and the howdynet.io zone. If the custom-domain deploy is refused, add
   Zone > DNS:Edit and SSL and Certificates:Edit.
4. **GitHub:** secrets `CLOUDFLARE_WORKERS_API_TOKEN`, `TURNSTILE_SECRET`
   (`terraform output -raw turnstile_secret`); variable `TURNSTILE_SITEKEY`
   (`terraform output turnstile_sitekey`). `CLOUDFLARE_ACCOUNT_ID` is shared with Terraform.
5. **Admin sign-in** (`./howdy admin` does all of this): create a Google OAuth client (Google
   Cloud Console > APIs & Services > Credentials > OAuth client ID > Web application, redirect URI
   `https://lts-inc.cloudflareaccess.com/cdn-cgi/access/callback`), apply Terraform with
   `admin_access = true`, `google_client_id`, `google_client_secret` (and `admin_emails` if more
   than `support@howdynet.io`), then put `terraform output -raw admin_access_aud` into
   `site/wrangler.jsonc` as `vars.ACCESS_AUD` next to `ACCESS_TEAM_DOMAIN` and `ADMIN_EMAILS`,
   build and deploy. Anonymous requests to `/admin` must then redirect to the Access login, and
   a Google account outside the list must be refused. CI needs `ADMIN_ACCESS=true` plus the
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets for Terraform.

### Cutover of www.howdynet.io from Pages to the Worker

1. Build (`npm run build`). Deploys always use the generated `dist/server/wrangler.json`, never the
   source `wrangler.jsonc`. For a preview without the custom domain, copy that generated file to
   `dist/server/wrangler.preview.json`, delete its `routes` key, and run
   `npx wrangler deploy -c dist/server/wrangler.preview.json`. Check
   `howdynet-www.<account>.workers.dev` renders (Turnstile will not render there because the
   widget is limited to howdynet.io hostnames).
2. Dashboard: Workers & Pages > the Pages project > Custom domains > remove `www.howdynet.io`;
   DNS > delete the `www` record. The Worker custom domain refuses to overwrite an existing record.
3. `npx wrangler deploy -c dist/server/wrangler.json` (the config carries the custom-domain route). Cloudflare creates
   the proxied `www` record and certificate; expect seconds to a couple of minutes of downtime
   between steps 2 and 3. Then set the GitHub variable `WWW_CUTOVER=true` so CI deploys on main.
4. Verify:

```sh
curl -sI https://www.howdynet.io/ | grep -iE 'strict-transport|x-content-type|referrer|permissions|x-frame'
curl -sI https://www.howdynet.io/robots.txt | head -3     # 200 text/plain
curl -sI https://www.howdynet.io/privacy | head -1         # 200
curl -s -o /dev/null -w '%{http_code}\n' https://www.howdynet.io/api/form   # 405
curl -si https://www.howdynet.io/.well-known/security.txt | head -3   # still Cloudflare-native
```

5. Keep the Pages project for a week, then delete it.

### Known follow-ups

- Testimonials ship with bracketed `[NAME]`, `[TITLE]`, `[COMPANY]` placeholders until clients
  approve attribution; replace them on `/admin`.
- The site sets only strictly necessary cookies; there is no analytics script and no cookie banner.
- No Content-Security-Policy yet. The only inline scripts left are the JSON-LD block, the
  anchor-forward snippet on the home page and the extras config; a nonce-based policy is now
  feasible.
