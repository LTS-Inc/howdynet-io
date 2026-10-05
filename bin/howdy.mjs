#!/usr/bin/env node
// howdy — one-command bootstrap for howdynet.io on Cloudflare.
//
//   ./howdy up        everything below, in order, idempotently
//   ./howdy setup     Cloudflare API token (stored in the macOS Keychain)
//   ./howdy status    read-only report of what exists
//   ./howdy infra     R2 state bucket + Terraform apply (zone settings, DNS, Turnstile, ...)
//   ./howdy site      KV namespace, Turnstile secret, build, preview deploy to workers.dev, smoke test
//   ./howdy cutover   move www.howdynet.io from Pages to the Worker
//   ./howdy github    push CI secrets/variables with `gh` (or print them)
//   ./howdy selftest  unit checks for the pure helpers
//
// Flags: --dry-run (print every mutation, change nothing)  --yes (no prompts)
//        --local-state (Terraform state in terraform/terraform.tfstate instead of R2)
//        --force-secrets (re-push TURNSTILE_SECRET)  --email-sending-done (silence that reminder)
//
// Zero dependencies: Node >= 22, native fetch. Runs `terraform`, `npx wrangler`, `gh`, `security`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------- constants
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "site");
const TF_DIR = path.join(ROOT, "terraform");
const ZONE = "howdynet.io";
const WWW = `www.${ZONE}`;
const WORKER = "howdynet-www";
const BUCKET = "howdynet-io-tfstate";
const STATE_KEY = "howdynet-io/terraform.tfstate";
const KV_TITLE = "howdynet-www-FORM_SUBMISSIONS";
const KV_PLACEHOLDER = "REPLACE_WITH_KV_NAMESPACE_ID";
const SUPPORT = "support@howdynet.io";
const KEYCHAIN_SERVICE = "howdynet-cloudflare";
const API = process.env.HOWDY_API_BASE || "https://api.cloudflare.com/client/v4";
const STATE_FILE = path.join(ROOT, ".howdy.json");

const TOKEN_PERMISSIONS = [
  ["User", "User Details: Read", "API Tokens: Edit (only to mint the R2 state credentials)"],
  ["Account", "Account Settings: Edit", "Turnstile: Edit", "Access: Apps and Policies: Edit", "Workers Scripts: Edit",
    "Workers KV Storage: Edit", "Workers R2 Storage: Edit", "Cloudflare Pages: Edit", "Email Routing Addresses: Edit"],
  ["Zone (howdynet.io)", "Zone: Read", "Zone Settings: Edit", "DNS: Edit", "Bot Management: Edit",
    "Access: Apps and Policies: Edit", "Workers Routes: Edit", "SSL and Certificates: Edit", "Zone WAF: Edit"],
];
const TOKEN_TEMPLATE_URL = "https://dash.cloudflare.com/profile/api-tokens?name=howdynet-io&accountId=*&zoneId=all&permissionGroupKeys=" +
  encodeURIComponent(JSON.stringify([
    { key: "dns", type: "edit" }, { key: "zone_settings", type: "edit" }, { key: "workers_scripts", type: "edit" }, { key: "access", type: "edit" },
  ]));

// ---------------------------------------------------------------------------------- cli args
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith("--")) ?? "help";
const flags = {
  dryRun: argv.includes("--dry-run"),
  yes: argv.includes("--yes"),
  localState: argv.includes("--local-state"),
  forceSecrets: argv.includes("--force-secrets"),
  emailSendingDone: argv.includes("--email-sending-done"),
};

// ---------------------------------------------------------------------------------- output
const c = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const log = (s = "") => console.log(s);
const step = (s) => log(`\n${c("1;36", "==>")} ${c("1", s)}`);
const ok = (s) => log(`  ${c("32", "✓")} ${s}`);
const skip = (s) => log(`  ${c("2", "–")} ${c("2", s)}`);
const warn = (s) => log(`  ${c("33", "!")} ${s}`);
const todo = (s) => log(`  ${c("1;33", "TODO")} ${s}`);
const dry = (s) => log(`  ${c("35", "dry-run")} ${s}`);
const die = (s) => { console.error(`\n${c("31", "error:")} ${s}`); process.exit(1); };

const manual = [];
const remember = (s) => { if (!manual.includes(s)) manual.push(s); };

// ---------------------------------------------------------------------------------- local state (.howdy.json)
function loadLocal() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}
function saveLocal(patch) {
  if (flags.dryRun) return;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...loadLocal(), ...patch }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------------- credentials (Keychain on macOS, 0600 file elsewhere)
const CRED_FILE = path.join(os.homedir(), ".config", "howdy", "credentials.json");
function credGet(account) {
  if (process.platform === "darwin") {
    const r = spawnSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.trim() : null;
  }
  try { return JSON.parse(fs.readFileSync(CRED_FILE, "utf8"))[account] ?? null; } catch { return null; }
}
function credSet(account, value) {
  if (flags.dryRun) return dry(`store credential ${account}`);
  if (process.platform === "darwin") {
    const r = spawnSync("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value], { encoding: "utf8" });
    if (r.status !== 0) die(`Keychain write failed: ${r.stderr}`);
    return;
  }
  fs.mkdirSync(path.dirname(CRED_FILE), { recursive: true, mode: 0o700 });
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(CRED_FILE, "utf8")); } catch { /* new */ }
  fs.writeFileSync(CRED_FILE, JSON.stringify({ ...cur, [account]: value }, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------------- cloudflare api
let TOKEN = process.env.CLOUDFLARE_API_TOKEN || credGet("api-token");

async function cf(method, p, body, { raw = false, token = TOKEN } = {}) {
  const mutates = method !== "GET";
  if (mutates && flags.dryRun) { dry(`${method} ${p}${body ? " " + JSON.stringify(body) : ""}`); return { dryRun: true }; }
  if (!token) die("no API token. Run `./howdy setup` first.");
  const res = await fetch(API + p, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (raw) return { status: res.status, json };
  if (!res.ok || json.success === false) {
    const msg = (json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || `${res.status} ${res.statusText}`;
    throw new Error(`${method} ${p} -> ${msg}`);
  }
  return json.result;
}
const cfTry = async (...a) => { try { return await cf(...a); } catch { return null; } };

// ---------------------------------------------------------------------------------- subprocesses
function run(command, args, { cwd = ROOT, env = {}, input, capture = false, mutates = true, quiet = false } = {}) {
  const shown = `${command} ${args.join(" ")}`;
  if (mutates && flags.dryRun) { dry(`$ ${shown}`); return { status: 0, stdout: "" }; }
  if (!quiet) log(`  ${c("2", "$ " + shown)}`);
  const r = spawnSync(command, args, {
    cwd, input, encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: capture ? ["pipe", "pipe", "inherit"] : [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (r.error) die(`${command}: ${r.error.message}`);
  return r;
}
const has = (bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const wrangler = (args, opts = {}) => run("npx", ["wrangler", ...args], { cwd: SITE, env: { CLOUDFLARE_API_TOKEN: TOKEN ?? "" }, ...opts });

async function confirm(q) {
  if (flags.yes || flags.dryRun) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${q} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}
async function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(q)).trim();
  rl.close();
  return a;
}

// ---------------------------------------------------------------------------------- pure helpers (covered by selftest)
export function buildDmarc(existing) {
  const tags = new Map();
  for (const part of (existing ?? "").replace(/^"|"$/g, "").split(";")) {
    const m = part.trim().match(/^([a-z]+)\s*=\s*(.+)$/i);
    if (m) tags.set(m[1].toLowerCase(), m[2].trim());
  }
  const rua = new Set((tags.get("rua") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  rua.add("mailto:postmaster@howdynet.io");
  const out = [["v", "DMARC1"], ["p", "quarantine"], ["pct", "100"], ["rua", [...rua].join(",")], ["fo", "1"]];
  for (const k of ["ruf", "adkim", "aspf", "sp", "ri", "rf"]) if (tags.has(k)) out.push([k, tags.get(k)]);
  return out.map(([k, v]) => `${k}=${v}`).join("; ");
}

export function patchKvId(jsonc, id) {
  const re = /("binding":\s*"FORM_SUBMISSIONS",\s*"id":\s*")[^"]*(")/;
  if (!re.test(jsonc)) throw new Error("FORM_SUBMISSIONS binding not found in wrangler.jsonc");
  return jsonc.replace(re, `$1${id}$2`);
}

export function previewConfig(jsonc) {
  // Same config without the custom-domain route, so a deploy touches only workers.dev.
  const out = jsonc.replace(/^[ \t]*"routes":\s*\[[^\n]*\],?[ \t]*\n/m, "");
  if (out === jsonc) throw new Error("routes line not found in wrangler.jsonc");
  return out;
}

export function readKvId(jsonc) {
  const m = jsonc.match(/"binding":\s*"FORM_SUBMISSIONS",\s*"id":\s*"([^"]*)"/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------------- discovery
async function discover() {
  const d = {};
  const verify = await cf("GET", "/user/tokens/verify");
  d.tokenStatus = verify.status;
  const user = await cf("GET", "/user");
  d.email = user.email;
  d.user2fa = !!user.two_factor_authentication_enabled;
  const accounts = await cf("GET", "/accounts?per_page=50");
  const zones = await cf("GET", `/zones?name=${ZONE}`);
  if (!zones.length) die(`zone ${ZONE} not visible to this token`);
  d.zoneId = zones[0].id;
  d.accountId = zones[0].account?.id ?? accounts[0]?.id;
  const acct = await cf("GET", `/accounts/${d.accountId}`);
  d.accountName = acct.name;
  d.enforce2faNow = !!acct.settings?.enforce_twofactor;
  const dmarc = await cf("GET", `/zones/${d.zoneId}/dns_records?type=TXT&name=_dmarc.${ZONE}`);
  d.dmarc = dmarc[0] ? { id: dmarc[0].id, content: dmarc[0].content } : null;
  const www = await cf("GET", `/zones/${d.zoneId}/dns_records?name=${WWW}`);
  d.wwwRecords = www.map((r) => ({ id: r.id, type: r.type, content: r.content, proxied: r.proxied }));
  const pages = (await cfTry("GET", `/accounts/${d.accountId}/pages/projects?per_page=50`)) ?? [];
  d.pagesWithWww = pages.filter((p) => (p.domains ?? []).includes(WWW)).map((p) => p.name);
  const wd = (await cfTry("GET", `/accounts/${d.accountId}/workers/domains?hostname=${WWW}`)) ?? [];
  d.workerDomain = wd.find((x) => x.hostname === WWW) ?? null;
  const kvs = (await cfTry("GET", `/accounts/${d.accountId}/storage/kv/namespaces?per_page=100`)) ?? [];
  d.kv = kvs.find((k) => k.title === KV_TITLE) ?? null;
  const addrs = (await cfTry("GET", `/accounts/${d.accountId}/email/routing/addresses?per_page=50`)) ?? [];
  d.supportAddr = addrs.find((a) => a.email === SUPPORT) ?? null;
  const buckets = (await cfTry("GET", `/accounts/${d.accountId}/r2/buckets?per_page=100`)) ?? { buckets: [] };
  d.bucket = (buckets.buckets ?? buckets ?? []).some((b) => b.name === BUCKET);
  const scripts = (await cfTry("GET", `/accounts/${d.accountId}/workers/scripts`)) ?? [];
  d.worker = scripts.some((s) => s.id === WORKER);
  const sub = await cfTry("GET", `/accounts/${d.accountId}/workers/subdomain`);
  d.workersDev = sub?.subdomain ? `https://${WORKER}.${sub.subdomain}.workers.dev` : null;
  d.widgets = (await cfTry("GET", `/accounts/${d.accountId}/challenges/widgets?per_page=50`)) ?? [];
  return d;
}

function printStatus(d) {
  const row = (k, v) => log(`  ${k.padEnd(26)} ${v}`);
  const yn = (b, t = "yes", f = "no") => (b ? c("32", t) : c("33", f));
  step(`Status for ${ZONE}`);
  row("token", `${d.tokenStatus} (${d.email})`);
  row("account", `${d.accountName} (${d.accountId})`);
  row("zone id", d.zoneId);
  row("your user has 2FA", yn(d.user2fa));
  row("account enforces 2FA", yn(d.enforce2faNow, "yes", "not yet"));
  row("DMARC", d.dmarc ? d.dmarc.content : c("33", "missing"));
  row("R2 state bucket", yn(d.bucket, BUCKET, "missing"));
  row("KV namespace", d.kv ? d.kv.id : c("33", "missing"));
  row("Turnstile widget", d.widgets.length ? d.widgets.map((w) => w.name).join(", ") : c("33", "none"));
  row("support@ destination", d.supportAddr ? (d.supportAddr.verified ? c("32", "verified") : c("33", "created, not verified")) : c("33", "missing"));
  row("Worker " + WORKER, yn(d.worker, "deployed", "not deployed") + (d.workersDev ? `  ${d.workersDev}` : ""));
  row("www DNS record", d.wwwRecords.length ? d.wwwRecords.map((r) => `${r.type} ${r.content}`).join(", ") : "none");
  row("www on Pages project", d.pagesWithWww.length ? c("33", d.pagesWithWww.join(", ")) : "no");
  row("www on Worker", d.workerDomain ? c("32", `${d.workerDomain.service} (${d.workerDomain.status ?? "active"})`) : c("33", "no"));
}

// ---------------------------------------------------------------------------------- steps
async function stepToolchain() {
  step("Toolchain");
  const node = process.versions.node.split(".").map(Number);
  if (node[0] < 22 || (node[0] === 22 && node[1] < 12)) die(`Node >= 22.12 required (have ${process.versions.node}). Run ./howdy instead (the wrapper fetches a pinned Node into .tools).`);
  ok(`node ${process.versions.node}`);
  if (!has("terraform")) die("terraform not found. Run ./howdy instead (the wrapper fetches a pinned Terraform into .tools).");
  ok(run("terraform", ["version"], { capture: true, mutates: false, quiet: true }).stdout.split("\n")[0]);
  if (!fs.existsSync(path.join(SITE, "node_modules", ".bin", "wrangler"))) {
    run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: SITE });
  } else skip("site/node_modules present");
}

async function stepToken() {
  step("Cloudflare API token");
  if (TOKEN) {
    const v = await cf("GET", "/user/tokens/verify", undefined, { raw: true });
    if (v.status === 200 && v.json.result?.status === "active") { ok(`token active (${process.env.CLOUDFLARE_API_TOKEN ? "from env" : "from keychain"})`); return; }
    warn("stored token is not active; asking for a new one");
  }
  log(`
  Create one API token that drives Terraform, wrangler and this script.
  Open (pre-fills part of it):\n    ${TOKEN_TEMPLATE_URL}
  Add the rest so the token has:`);
  for (const [scope, ...perms] of TOKEN_PERMISSIONS) log(`    ${c("1", scope)}: ${perms.join(" · ")}`);
  log("  Account Resources: your account.  Zone Resources: howdynet.io.  TTL: your call (rotate with ./howdy setup).\n");
  if (flags.dryRun) { dry("prompt for token"); return; }
  const t = await ask("  Paste the token: ");
  if (!t) die("no token given");
  const v = await cf("GET", "/user/tokens/verify", undefined, { raw: true, token: t });
  if (v.status !== 200 || v.json.result?.status !== "active") die(`token rejected: ${JSON.stringify(v.json.errors ?? v.json)}`);
  TOKEN = t;
  credSet("api-token", t);
  ok("token verified and stored");
}

async function probeToken(d) {
  step("Token permission probe");
  const checks = [
    ["Zone Settings", `/zones/${d.zoneId}/settings/security_header`],
    ["DNS", `/zones/${d.zoneId}/dns_records?per_page=1`],
    ["Bot Management", `/zones/${d.zoneId}/bot_management`],
    ["Access: Apps and Policies", `/accounts/${d.accountId}/access/apps?per_page=1`],
    ["Turnstile", `/accounts/${d.accountId}/challenges/widgets?per_page=1`],
    ["Workers Scripts", `/accounts/${d.accountId}/workers/scripts`],
    ["Workers KV Storage", `/accounts/${d.accountId}/storage/kv/namespaces?per_page=1`],
    ["Workers R2 Storage", `/accounts/${d.accountId}/r2/buckets?per_page=1`],
    ["Cloudflare Pages", `/accounts/${d.accountId}/pages/projects?per_page=1`],
    ["Email Routing Addresses", `/accounts/${d.accountId}/email/routing/addresses?per_page=1`],
    ["SSL and Certificates", `/zones/${d.zoneId}/ssl/certificate_packs?per_page=1`],
    ["API Tokens (R2 state creds)", `/user/tokens/permission_groups`],
  ];
  const missing = [];
  for (const [name, p] of checks) {
    const r = await cf("GET", p, undefined, { raw: true });
    if (r.status === 200) ok(name); else { warn(`${name}: HTTP ${r.status}`); missing.push(name); }
  }
  if (missing.length) {
    const fatal = missing.filter((m) => !(flags.localState && m.startsWith("API Tokens")));
    if (fatal.length) die(`token lacks: ${fatal.join(", ")}. Edit the token in the dashboard, then re-run.`);
  }
}

async function stepTwoFactor(d) {
  step("Two-factor authentication");
  if (d.user2fa) { ok(`${d.email} has 2FA`); return true; }
  todo(`enable 2FA for ${d.email}: dash.cloudflare.com > My Profile > Authentication (every account member must do this). Re-run ./howdy up afterwards to enforce it account-wide.`);
  remember("Enable 2FA on your Cloudflare user, then re-run ./howdy up");
  return false;
}

async function stepR2State(d) {
  step("Terraform state (R2)");
  if (flags.localState) { skip("--local-state: using terraform/terraform.tfstate"); return null; }
  if (d.bucket) skip(`bucket ${BUCKET} exists`);
  else {
    await cf("POST", `/accounts/${d.accountId}/r2/buckets`, { name: BUCKET });
    ok(`created bucket ${BUCKET}`);
  }
  let keyId = process.env.R2_ACCESS_KEY_ID || credGet("r2-access-key-id");
  let secret = process.env.R2_SECRET_ACCESS_KEY || credGet("r2-secret-access-key");
  if (keyId && secret) { skip("R2 S3 credentials present"); return { keyId, secret }; }
  const groups = await cf("GET", "/user/tokens/permission_groups");
  const g = groups.find((x) => x.name === "Workers R2 Storage Write") ?? groups.find((x) => /R2/.test(x.name) && /Write|Edit/.test(x.name) && (x.scopes ?? []).includes("com.cloudflare.api.account"));
  if (!g) die("could not find the 'Workers R2 Storage Write' permission group");
  const tok = await cf("POST", "/user/tokens", {
    name: `${BUCKET} (terraform state, created by howdy)`,
    policies: [{ effect: "allow", resources: { [`com.cloudflare.api.account.${d.accountId}`]: "*" }, permission_groups: [{ id: g.id, name: g.name }] }],
  });
  if (tok.dryRun) return { keyId: "dry", secret: "dry" };
  keyId = tok.id;
  secret = createHash("sha256").update(tok.value).digest("hex");
  credSet("r2-access-key-id", keyId);
  credSet("r2-secret-access-key", secret);
  ok("minted R2 S3 credentials (Access Key = token id, Secret = sha256(token))");
  return { keyId, secret };
}

function tfEnv(d, r2, enforce2fa) {
  return {
    CLOUDFLARE_API_TOKEN: TOKEN ?? "",
    TF_VAR_account_id: d.accountId,
    TF_VAR_account_name: d.accountName,
    TF_VAR_zone_name: ZONE,
    TF_VAR_dmarc_record: buildDmarc(d.dmarc?.content),
    TF_VAR_enforce_2fa: enforce2fa ? "true" : "false",
    TF_IN_AUTOMATION: "1",
    ...(r2 ? { AWS_ACCESS_KEY_ID: r2.keyId, AWS_SECRET_ACCESS_KEY: r2.secret } : {}),
  };
}

function backendArgs(d, r2) {
  if (!r2) return ["-backend=false"];
  return [
    `-backend-config=bucket=${BUCKET}`, `-backend-config=key=${STATE_KEY}`, "-backend-config=region=auto",
    `-backend-config=endpoints={s3="https://${d.accountId}.r2.cloudflarestorage.com"}`,
    "-backend-config=skip_credentials_validation=true", "-backend-config=skip_region_validation=true",
    "-backend-config=skip_requesting_account_id=true", "-backend-config=skip_metadata_api_check=true",
    "-backend-config=skip_s3_checksum=true", "-backend-config=use_path_style=true", "-backend-config=use_lockfile=true",
  ];
}

async function stepTerraform(d, r2, enforce2fa) {
  step("Terraform (zone settings, DMARC, security.txt, Turnstile, Access bypass" + (enforce2fa ? ", 2FA enforcement" : "") + ")");
  const env = tfEnv(d, r2, enforce2fa);
  log(`  DMARC will be: ${c("1", env.TF_VAR_dmarc_record)}`);
  if (flags.localState) {
    // Local state: the config declares an s3 backend; override it with a local one for this run.
    const override = path.join(TF_DIR, "backend_override.tf");
    if (!fs.existsSync(override) && !flags.dryRun) fs.writeFileSync(override, 'terraform {\n  backend "local" {}\n}\n');
  }
  run("terraform", ["init", "-input=false", "-reconfigure", "-no-color", ...(flags.localState ? [] : backendArgs(d, r2))], { cwd: TF_DIR, env });
  const plan = run("terraform", ["plan", "-input=false", "-no-color", "-detailed-exitcode", "-out=tfplan"], { cwd: TF_DIR, env });
  if (flags.dryRun) { dry("terraform plan/apply"); return; }
  if (plan.status === 1) die("terraform plan failed");
  if (plan.status === 0) { ok("no infrastructure changes"); return; }
  if (!(await confirm("  Apply these Terraform changes?"))) die("aborted");
  const apply = run("terraform", ["apply", "-input=false", "-no-color", "tfplan"], { cwd: TF_DIR, env });
  if (apply.status !== 0) die("terraform apply failed");
  ok("applied");
}

function tfOutput(name, d, r2, enforce2fa) {
  if (flags.dryRun) return `<${name}>`;
  const r = run("terraform", ["output", "-raw", name], { cwd: TF_DIR, env: tfEnv(d, r2, enforce2fa), capture: true, mutates: false, quiet: true });
  if (r.status !== 0) die(`terraform output ${name} failed (run ./howdy infra first)`);
  return r.stdout.trim();
}

async function stepTurnstile(d, r2, enforce2fa) {
  step("Turnstile keys -> site");
  const sitekey = tfOutput("turnstile_sitekey", d, r2, enforce2fa);
  const secret = tfOutput("turnstile_secret", d, r2, enforce2fa);
  const envFile = path.join(SITE, ".env");
  const line = `PUBLIC_TURNSTILE_SITEKEY=${sitekey}\n`;
  if (!flags.dryRun) fs.writeFileSync(envFile, line);
  ok(`site/.env PUBLIC_TURNSTILE_SITEKEY=${sitekey}`);
  let existing = [];
  if (!flags.dryRun) {
    const list = wrangler(["secret", "list"], { capture: true, quiet: true });
    try { existing = JSON.parse(list.stdout).map((s) => s.name); } catch { existing = []; }
  }
  if (existing.includes("TURNSTILE_SECRET") && !flags.forceSecrets) skip("TURNSTILE_SECRET already set on the Worker (--force-secrets to re-push)");
  else {
    const r = wrangler(["secret", "put", "TURNSTILE_SECRET"], { input: secret });
    if (r.status !== 0) {
      // First-ever secret on a Worker that does not exist yet: wrangler asks to create it; deploy first then.
      warn("secret put failed (Worker may not exist yet); will retry after the first deploy");
      return { sitekey, secret, retry: true };
    }
    ok("TURNSTILE_SECRET pushed");
  }
  return { sitekey, secret };
}

async function stepEmail(d) {
  step("Email delivery for form submissions");
  if (!d.supportAddr) {
    await cf("POST", `/accounts/${d.accountId}/email/routing/addresses`, { email: SUPPORT });
    ok(`destination address ${SUPPORT} created; Cloudflare emailed a verification link`);
    remember(`Click the verification link Cloudflare sent to ${SUPPORT}`);
  } else if (!d.supportAddr.verified) {
    todo(`${SUPPORT} is created but not verified: click the link in the email from Cloudflare (re-send: dashboard > Email > Destination addresses)`);
    remember(`Click the verification link Cloudflare sent to ${SUPPORT}`);
  } else ok(`${SUPPORT} verified`);
  if (flags.emailSendingDone) saveLocal({ emailSendingDone: true });
  if (!loadLocal().emailSendingDone && !flags.emailSendingDone) {
    todo(`one-time, dashboard only: Compute > Email Service > Email Sending > Onboard domain, choose subdomain "mail.${ZONE}". The Worker sends from forms@mail.${ZONE}. Until then submissions are kept in KV only. Then run: ./howdy up --email-sending-done`);
    remember(`Onboard mail.${ZONE} for Email Sending, then ./howdy up --email-sending-done`);
  } else ok(`mail.${ZONE} onboarding acknowledged`);
}

async function stepKv(d) {
  step("KV namespace for form submissions");
  let id = d.kv?.id;
  if (id) skip(`${KV_TITLE} exists (${id})`);
  else {
    const r = await cf("POST", `/accounts/${d.accountId}/storage/kv/namespaces`, { title: KV_TITLE });
    id = r.dryRun ? "<new-kv-id>" : r.id;
    ok(`created ${KV_TITLE} (${id})`);
  }
  const file = path.join(SITE, "wrangler.jsonc");
  const jsonc = fs.readFileSync(file, "utf8");
  if (readKvId(jsonc) === id) skip("wrangler.jsonc already has the id");
  else if (flags.dryRun) dry(`write KV id into site/wrangler.jsonc`);
  else { fs.writeFileSync(file, patchKvId(jsonc, id)); ok("wrote KV id into site/wrangler.jsonc (commit this)"); }
  return id;
}

async function stepBuild(sitekey) {
  step("Build site");
  const r = run("npm", ["run", "build"], { cwd: SITE, env: { PUBLIC_TURNSTILE_SITEKEY: sitekey } });
  if (r.status !== 0) die("astro build failed");
  ok("built site/dist");
}

async function smoke(base) {
  const checks = [
    ["GET", "/", (r) => r.status === 200],
    ["GET", "/privacy", (r) => r.status === 200],
    ["GET", "/terms", (r) => r.status === 200],
    ["GET", "/robots.txt", (r) => r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/plain")],
    ["GET", "/api/form", (r) => r.status === 405],
    ["POST", "/api/form", (r) => r.status >= 400 && r.status < 500],
  ];
  let allOk = true;
  for (const [m, p, test] of checks) {
    let pass = false, status = "-";
    for (let i = 0; i < 12 && !pass; i++) {
      try {
        const r = await fetch(base + p, { method: m, redirect: "manual", headers: m === "POST" ? { Origin: base, "Content-Type": "application/x-www-form-urlencoded" } : {}, body: m === "POST" ? "form-name=contact" : undefined });
        status = r.status; pass = test(r);
      } catch (e) { status = e.message; }
      if (!pass) await new Promise((res) => setTimeout(res, 5000));
    }
    (pass ? ok : warn)(`${m} ${p} -> ${status}`);
    allOk &&= pass;
  }
  return allOk;
}

async function stepPreviewDeploy(d) {
  step("Preview deploy to workers.dev (no DNS changes)");
  const src = path.join(SITE, "wrangler.jsonc");
  const preview = path.join(SITE, "wrangler.preview.jsonc");
  if (!flags.dryRun) fs.writeFileSync(preview, previewConfig(fs.readFileSync(src, "utf8")));
  const r = wrangler(["deploy", "-c", "wrangler.preview.jsonc"]);
  if (r.status !== 0) die("preview deploy failed");
  const sub = await cfTry("GET", `/accounts/${d.accountId}/workers/subdomain`);
  const base = sub?.subdomain ? `https://${WORKER}.${sub.subdomain}.workers.dev` : d.workersDev;
  if (!base) { warn("no workers.dev subdomain found; skipping smoke test"); return true; }
  if (flags.dryRun) { dry(`smoke test ${base}`); return true; }
  log(`  smoke testing ${base}`);
  const good = await smoke(base);
  if (!good) die("smoke test failed on the preview; fix before cutover");
  ok(`preview healthy: ${base}`);
  return true;
}

async function stepCutover(d) {
  step(`Cutover: ${WWW} from Pages to Worker ${WORKER}`);
  if (d.workerDomain && d.workerDomain.service === WORKER) { ok(`${WWW} already bound to ${WORKER}`); return false; }
  log(`  This removes ${WWW} from Pages project(s) [${d.pagesWithWww.join(", ") || "none"}], deletes the www DNS record(s) [${d.wwwRecords.map((r) => r.type).join(", ") || "none"}],`);
  log(`  then deploys the Worker with its custom domain (Cloudflare recreates the record + cert). Expected gap: seconds to ~2 minutes.`);
  if (!(await confirm("  Proceed with the cutover now?"))) { warn("cutover skipped; run ./howdy cutover when ready"); remember("Run ./howdy cutover"); return false; }
  const t0 = Date.now();
  for (const p of d.pagesWithWww) {
    await cf("DELETE", `/accounts/${d.accountId}/pages/projects/${p}/domains/${WWW}`);
    ok(`removed ${WWW} from Pages project ${p}`);
  }
  for (const r of d.wwwRecords) {
    await cf("DELETE", `/zones/${d.zoneId}/dns_records/${r.id}`);
    ok(`deleted DNS ${r.type} ${WWW}`);
  }
  const dep = wrangler(["deploy"]);
  if (dep.status !== 0) die(`deploy with custom domain failed. Re-run ./howdy cutover (the www record is gone; the Worker will claim it).`);
  ok("deployed with custom domain");
  if (flags.dryRun) return true;
  process.stdout.write("  waiting for https://" + WWW + "/ ");
  let live = false;
  for (let i = 0; i < 60 && !live; i++) {
    try {
      const r = await fetch(`https://${WWW}/`, { redirect: "manual" });
      live = r.status === 200 && (r.headers.get("permissions-policy") ?? "").includes("camera");
    } catch { /* retry */ }
    if (!live) { process.stdout.write("."); await new Promise((res) => setTimeout(res, 5000)); }
  }
  log("");
  if (!live) warn(`${WWW} not serving the Worker yet after 5 minutes; check Workers > ${WORKER} > Domains & Routes`);
  else ok(`${WWW} is live on the Worker (gap: ${Math.round((Date.now() - t0) / 1000)}s)`);
  return true;
}

async function stepGithub(d, r2, keys, enforce2fa, cutoverDone) {
  step("GitHub Actions secrets and variables");
  const secrets = {
    CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_WORKERS_API_TOKEN: TOKEN,
    ...(r2 ? { R2_ACCESS_KEY_ID: r2.keyId, R2_SECRET_ACCESS_KEY: r2.secret } : {}),
    TURNSTILE_SECRET: keys?.secret,
  };
  const vars = {
    CLOUDFLARE_ACCOUNT_ID: d.accountId, CLOUDFLARE_ACCOUNT_NAME: d.accountName,
    DMARC_RECORD: buildDmarc(d.dmarc?.content), ENFORCE_2FA: enforce2fa ? "true" : "false",
    TURNSTILE_SITEKEY: keys?.sitekey, WWW_CUTOVER: cutoverDone ? "true" : "false",
  };
  const ghOk = has("gh") && spawnSync("gh", ["auth", "status"], { stdio: "ignore" }).status === 0;
  if (!ghOk) {
    warn("GitHub CLI not installed/authenticated (brew install gh && gh auth login). Set these in GitHub > Settings > Secrets and variables > Actions:");
    for (const [k, v] of Object.entries(secrets)) log(`    secret   ${k.padEnd(28)} ${v ? "(" + (k.includes("TOKEN") || k.includes("SECRET") ? "redacted, in your Keychain" : v) + ")" : "-"}`);
    for (const [k, v] of Object.entries(vars)) log(`    variable ${k.padEnd(28)} ${v}`);
    remember("Set the GitHub Actions secrets/variables (or install gh and re-run ./howdy github)");
    return;
  }
  for (const [k, v] of Object.entries(secrets)) if (v) { run("gh", ["secret", "set", k], { input: v }); ok(`secret ${k}`); }
  for (const [k, v] of Object.entries(vars)) if (v) { run("gh", ["variable", "set", k, "--body", v]); ok(`variable ${k}`); }
}

function report() {
  step("Done");
  if (manual.length) { log("  Still on you:"); manual.forEach((m, i) => log(`    ${i + 1}. ${m}`)); }
  else ok("nothing left to do by hand");
  log(`  If site/wrangler.jsonc changed, commit it:  git add site/wrangler.jsonc && git commit -m "Set KV namespace id" && git push`);
  log(`  Re-run ./howdy status any time.\n`);
}

// ---------------------------------------------------------------------------------- commands
async function cmdUp() {
  await stepToolchain();
  await stepToken();
  if (flags.dryRun && !TOKEN) { dry("no token available: the remaining steps need API access. Run ./howdy setup, then ./howdy up --dry-run again."); return; }
  const d = await discover();
  printStatus(d);
  await probeToken(d);
  const enforce2fa = await stepTwoFactor(d);
  const r2 = await stepR2State(d);
  await stepTerraform(d, r2, enforce2fa);
  let keys = await stepTurnstile(d, r2, enforce2fa);
  await stepEmail(d);
  await stepKv(d);
  await stepBuild(keys.sitekey);
  await stepPreviewDeploy(d);
  if (keys.retry) keys = await stepTurnstile(d, r2, enforce2fa);
  const cut = await stepCutover(d);
  await stepGithub(d, r2, keys, enforce2fa, cut || !!(d.workerDomain && d.workerDomain.service === WORKER));
  report();
}

async function cmdStatus() {
  if (!TOKEN) die("no API token. Run ./howdy setup first.");
  printStatus(await discover());
}

async function cmdInfra() {
  await stepToolchain();
  await stepToken();
  const d = await discover();
  const enforce2fa = await stepTwoFactor(d);
  const r2 = await stepR2State(d);
  await stepTerraform(d, r2, enforce2fa);
  report();
}

async function cmdSite() {
  await stepToolchain();
  await stepToken();
  const d = await discover();
  const enforce2fa = d.user2fa;
  const r2 = flags.localState ? null : { keyId: credGet("r2-access-key-id") ?? process.env.R2_ACCESS_KEY_ID, secret: credGet("r2-secret-access-key") ?? process.env.R2_SECRET_ACCESS_KEY };
  const keys = await stepTurnstile(d, r2, enforce2fa);
  await stepEmail(d);
  await stepKv(d);
  await stepBuild(keys.sitekey);
  await stepPreviewDeploy(d);
  if (keys.retry) await stepTurnstile(d, r2, enforce2fa);
  report();
}

async function cmdCutover() {
  await stepToolchain();
  await stepToken();
  const d = await discover();
  printStatus(d);
  await stepPreviewDeploy(d);
  await stepCutover(d);
  report();
}

async function cmdGithub() {
  await stepToken();
  const d = await discover();
  const r2 = flags.localState ? null : { keyId: credGet("r2-access-key-id"), secret: credGet("r2-secret-access-key") };
  const keys = { sitekey: tfOutput("turnstile_sitekey", d, r2, d.user2fa), secret: tfOutput("turnstile_secret", d, r2, d.user2fa) };
  await stepGithub(d, r2, keys, d.user2fa, !!(d.workerDomain && d.workerDomain.service === WORKER));
}

function cmdSelftest() {
  const eq = (a, b, what) => { if (a !== b) { console.error(`FAIL ${what}\n  got:  ${a}\n  want: ${b}`); process.exitCode = 1; } else ok(what); };
  eq(buildDmarc('v=DMARC1; p=none; rua=mailto:postmaster@howdynet.io; fo=1'),
    "v=DMARC1; p=quarantine; pct=100; rua=mailto:postmaster@howdynet.io; fo=1", "dmarc: upgrade p=none");
  eq(buildDmarc('"v=DMARC1; p=none; rua=mailto:abc@dmarc-reports.cloudflare.net; adkim=s"'),
    "v=DMARC1; p=quarantine; pct=100; rua=mailto:abc@dmarc-reports.cloudflare.net,mailto:postmaster@howdynet.io; fo=1; adkim=s", "dmarc: keep cloudflare rua + adkim, strip quotes");
  eq(buildDmarc(undefined), "v=DMARC1; p=quarantine; pct=100; rua=mailto:postmaster@howdynet.io; fo=1", "dmarc: missing record");
  const jsonc = fs.readFileSync(path.join(SITE, "wrangler.jsonc"), "utf8");
  eq(readKvId(patchKvId(jsonc, "abc123")), "abc123", "kv: patch + read id");
  const prev = previewConfig(jsonc);
  eq(prev.includes('"routes"'), false, "preview: routes removed");
  eq(prev.includes('"custom_domain"'), false, "preview: custom_domain removed");
  eq(prev.includes('"send_email"') && prev.includes('"kv_namespaces"') && prev.includes('"assets"'), true, "preview: other bindings kept");
  eq(jsonc.split("\n").length - prev.split("\n").length, 1, "preview: exactly one line removed");
}

function help() {
  log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

const commands = { up: cmdUp, setup: stepToken, status: cmdStatus, infra: cmdInfra, site: cmdSite, cutover: cmdCutover, github: cmdGithub, selftest: cmdSelftest, help };
if (!commands[cmd]) { help(); die(`unknown command: ${cmd}`); }
try {
  await commands[cmd]();
} catch (e) {
  die(e.message);
}
