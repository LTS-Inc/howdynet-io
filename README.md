# howdynet-io

Source of truth for **howdynet.io** on Cloudflare (account LTS-Inc):

- `terraform/` — zone and account configuration that resolves Cloudflare's **Security Insights**
  findings (HSTS, Bot Fight Mode, AI crawler blocking, DMARC, security.txt, Turnstile, 2FA).
- `site/` — the **www.howdynet.io** website: Astro 7 on Cloudflare Workers (static assets) with a
  Worker endpoint that delivers the site's forms through Turnstile, KV and Cloudflare email.
- `howdy` — one command that sets all of it up from a Mac and moves `www` off Cloudflare Pages.

## Quickstart (macOS, Apple Silicon)

```sh
git clone git@github.com:LTS-Inc/howdynet-io.git && cd howdynet-io
./howdy up
```

That is the whole install. On first run it:

1. Fetches a pinned Node and Terraform into `.tools/` (checksum-verified official releases; no
   Homebrew, no Xcode tools, nothing installed system-wide) and the site's npm packages.
2. Asks you once for a Cloudflare API token (it prints the link and the permission checklist),
   verifies it, and stores it in your Keychain.
3. Finds your account and zone, creates the R2 bucket and credentials for Terraform state, and
   applies Terraform: HSTS, bot management, DMARC `p=quarantine`, native security.txt with an Access
   bypass on the apex, the Turnstile widget, and (once your user has 2FA) account-wide 2FA.
4. Pushes the Turnstile keys to the site, creates the form-submissions KV namespace and writes its
   id into `site/wrangler.jsonc`, registers `support@howdynet.io` as an email destination.
5. Builds the site, deploys a preview to workers.dev and smoke-tests it.
6. Asks for confirmation, then performs the cutover: removes `www.howdynet.io` from the Pages
   project, deletes the old `www` DNS record, deploys the Worker with its custom domain, and waits
   until `https://www.howdynet.io` serves from the Worker. Expected gap: seconds to about two minutes.
7. Sets the GitHub Actions secrets and variables if `gh` is installed, otherwise prints them.

Every step is idempotent: re-run `./howdy up` any time; it skips what already exists. To remove
the downloaded tools: `rm -rf .tools`.
Preview with `./howdy up --dry-run`, skip prompts with `--yes`, see the current state with
`./howdy status`.

## What `howdy` cannot do for you

It prints these as TODOs and lists them at the end:

- **Enable 2FA on your own Cloudflare user** (My Profile > Authentication). After that, re-run
  `./howdy up` and it enforces 2FA for the whole account.
- **Click the verification email** Cloudflare sends to `support@howdynet.io`.
- **Onboard `mail.howdynet.io` for Email Sending** (Compute > Email Service > Email Sending >
  Onboard domain, pick the subdomain). Until then, form submissions are stored in KV but not
  emailed. Acknowledge with `./howdy up --email-sending-done`.
- **Commit `site/wrangler.jsonc`** after the first run (it now holds the KV namespace id).

## Commands

| Command | What it does |
|---|---|
| `./howdy up` | Everything, in order. |
| `./howdy setup` | Enter or rotate the Cloudflare API token. |
| `./howdy status` | Read-only report: token, 2FA, DMARC, bucket, KV, Turnstile, email, Worker, where `www` points. |
| `./howdy infra` | R2 state + Terraform only. |
| `./howdy site` | Turnstile keys, KV, email destination, build, preview deploy, smoke test. |
| `./howdy cutover` | Preview deploy, smoke test, then the Pages-to-Worker switch. |
| `./howdy github` | Push CI secrets/variables with `gh`, or print them. |
| `./howdy selftest` | Unit checks for the DMARC builder and config patchers. |

Flags: `--dry-run`, `--yes`, `--local-state` (Terraform state on disk instead of R2),
`--force-secrets`, `--email-sending-done`. On Linux or CI, set `CLOUDFLARE_API_TOKEN` in the
environment instead of using the Keychain.

## Day two

- **Site changes:** edit under `site/`, open a PR (CI type-checks, builds and enforces a size
  gate), merge to `main` and CI deploys with wrangler. Local preview: `cd site && npm run dev`.
- **Zone changes:** edit under `terraform/`, open a PR (CI posts the plan), merge and the
  reviewer-gated apply runs.
- **Reading form submissions:** `cd site && npx wrangler kv key list --binding FORM_SUBMISSIONS`.
- **After a week on the Worker:** delete the old Pages project in the dashboard.
- **Yearly:** bump `security_txt_expires` in `terraform/variables.tf`.

Full manual procedure, token permissions, verification commands and design notes:
[docs/manual-setup.md](docs/manual-setup.md).
