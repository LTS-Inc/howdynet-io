#!/usr/bin/env node
// howdy — one-command bootstrap for howdynet.io on Cloudflare.
//
//   ./howdy up        everything below, in order, idempotently
//   ./howdy setup     Cloudflare API token (stored in the macOS Keychain)
//   ./howdy status    read-only report of what exists
//   ./howdy infra     R2 state bucket + Terraform apply (zone settings, DNS, Turnstile, ...)
//   ./howdy site      KV namespace, Turnstile secret, build, preview deploy to workers.dev, smoke test
//   ./howdy cutover   move www.howdynet.io from Pages to the Worker
//   ./howdy apex      move the internal portal off the bare domain, then redirect howdynet.io -> www
//   ./howdy github    push CI secrets/variables with `gh` (or print them)
//   ./howdy selftest  unit checks for the pure helpers
//
// Flags: --dry-run (print every mutation, change nothing)  --yes (no prompts)
//        --local-state (Terraform state in terraform/terraform.tfstate instead of R2)
//        --force-secrets (re-push TURNSTILE_SECRET)  --email-sending-done (silence that reminder)
//        --portal-host <fqdn> (apex: where the internal portal moves; default multi-frame.howdynet.io)
//
// Zero dependencies: Node >= 22, native fetch. Runs `terraform`, `npx wrangler`, `gh`, `security`.

import { spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
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
  portalHost: (argv[argv.indexOf("--portal-host") + 1] && argv.includes("--portal-host")) ? argv[argv.indexOf("--portal-host") + 1] : "multi-frame.howdynet.io",
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
async function askHidden(q) {
  // Echo muted: the secret never appears on screen or in terminal scrollback.
  const muted = new (await import("node:stream")).Writable({ write(_c, _e, cb) { cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stdout.write(q);
  const a = (await rl.question("")).trim();
  rl.close();
  process.stdout.write("\n");
  return a;
}
const redact = (t) => (t ? `${t.slice(0, 5)}…${t.slice(-4)}` : "");
const isAccountToken = () => (TOKEN ?? "").startsWith("cfat_");

// ---------------------------------------------------------------------------------- S3 SigV4 (to prove R2 credentials before Terraform uses them)
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const hmac = (key, s) => createHmac("sha256", key).update(s).digest();

export function sigV4Headers({ method, host, path: reqPath, query, keyId, secret, region = "auto", service = "s3", now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = "UNSIGNED-PAYLOAD";
  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((k) => `${k}:${headers[k]}\n`).join("");
  const canonicalQuery = Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join("&");
  const canonicalRequest = [method, reqPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
}

const REF_SIG = "b1a076428fa68c2c42202ee5a5718b8207f725e451e2157d6b1c393e01fc2e68"; // independent Python SigV4 for the selftest inputs
const r2Endpoint = (accountId) => process.env.HOWDY_R2_ENDPOINT || `https://${accountId}.r2.cloudflarestorage.com`;

export async function r2Check(accountId, keyId, secret) {
  const base = new URL(r2Endpoint(accountId));
  const query = { "list-type": "2", "max-keys": "1" };
  const headers = sigV4Headers({ method: "GET", host: base.host, path: `/${BUCKET}`, query, keyId, secret });
  try {
    const r = await fetch(`${base.origin}/${BUCKET}?list-type=2&max-keys=1`, { headers });
    return r.status;
  } catch (e) { return `error: ${e.message}`; }
}

export async function r2WaitForCreds(accountId, keyId, secret, { attempts = 18, delayMs = 5000 } = {}) {
  let status;
  for (let i = 0; i < attempts; i++) {
    status = await r2Check(accountId, keyId, secret);
    if (status === 200) return 200;
    if (i === 0) process.stdout.write(`  waiting for R2 to accept the credentials (HTTP ${status}) `);
    else process.stdout.write(".");
    await new Promise((res) => setTimeout(res, delayMs));
  }
  log("");
  return status;
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

// The adapter writes a fully resolved, deployable config at build time (main: entry.mjs,
// assets ../client, all bindings, routes). Deploys always use that file, never the source jsonc.
const GENERATED_CONFIG = path.join(SITE, "dist", "server", "wrangler.json");
const PREVIEW_CONFIG = path.join(SITE, "dist", "server", "wrangler.preview.json");

export function previewConfig(generatedJson) {
  // Same deployable config without the custom-domain route, so a deploy touches only workers.dev.
  const cfg = JSON.parse(generatedJson);
  if (!cfg.main || !cfg.assets?.directory) throw new Error("not a generated wrangler config (missing main/assets)");
  delete cfg.routes;
  return JSON.stringify(cfg, null, 2) + "\n";
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
  const user = isAccountToken() ? null : await cfTry("GET", "/user");
  d.email = user?.email ?? (isAccountToken() ? "account-owned token" : "unknown (token lacks User Details: Read)");
  const accounts = await cf("GET", "/accounts?per_page=50");
  const zones = await cf("GET", `/zones?name=${ZONE}`);
  if (!zones.length) die(`zone ${ZONE} not visible to this token`);
  d.zoneId = zones[0].id;
  d.accountId = zones[0].account?.id ?? accounts[0]?.id;
  const acct = await cf("GET", `/accounts/${d.accountId}`);
  d.accountName = acct.name;
  d.enforce2faNow = !!acct.settings?.enforce_twofactor;
  const members = (await cfTry("GET", `/accounts/${d.accountId}/members?per_page=100`)) ?? [];
  d.members = members.filter((m) => m.status === "accepted").map((m) => ({ email: m.user?.email ?? m.email, twofa: !!m.user?.two_factor_authentication_enabled }));
  d.membersWithout2fa = d.members.filter((m) => !m.twofa).map((m) => m.email);
  d.all2fa = d.members.length > 0 && d.membersWithout2fa.length === 0;
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
  const k = process.env.R2_ACCESS_KEY_ID || credGet("r2-access-key-id"), sk = process.env.R2_SECRET_ACCESS_KEY || credGet("r2-secret-access-key");
  d.r2CredStatus = d.bucket && k && sk ? await r2Check(d.accountId, k, sk) : null;
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
  row("members with 2FA", d.members.length ? `${d.members.length - d.membersWithout2fa.length}/${d.members.length}` + (d.membersWithout2fa.length ? c("33", `  missing: ${d.membersWithout2fa.join(", ")}`) : "") : c("33", "unknown"));
  row("account enforces 2FA", yn(d.enforce2faNow, "yes", "not yet"));
  row("DMARC", d.dmarc ? d.dmarc.content : c("33", "missing"));
  row("R2 state bucket", yn(d.bucket, BUCKET, "missing") + (d.r2CredStatus ? `  creds: ${d.r2CredStatus === 200 ? c("32", "accepted") : c("33", "rejected (HTTP " + d.r2CredStatus + ")")}` : ""));
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
    if (v.status === 200 && v.json.result?.status === "active") { ok(`token ${redact(TOKEN)} active (${process.env.CLOUDFLARE_API_TOKEN ? "from env" : "from keychain"}); replace it with ./howdy setup`); return; }
    warn("stored token is not active; asking for a new one");
  }
  log(`
  Create one API token that drives Terraform, wrangler and this script.
  Open this link; it pre-fills only four permissions (DNS, Zone Settings, Workers Scripts, Access):
    ${TOKEN_TEMPLATE_URL}
  Before clicking "Continue to summary", add the rest with "+ Add more" so the token has:`);
  for (const [scope, ...perms] of TOKEN_PERMISSIONS) log(`    ${c("1", scope)}: ${perms.join(" · ")}`);
  log("  Account Resources: your account.  Zone Resources: howdynet.io.  TTL: your call (rotate with ./howdy setup).");
  log("  A token missing something is reported below by name; fix it with API Tokens > (token) > Edit, then re-run.\n");
  if (flags.dryRun) { dry("prompt for token"); return; }
  const t = await askHidden("  Paste the token (input hidden): ");
  if (!t) die("no token given");
  const v = await cf("GET", "/user/tokens/verify", undefined, { raw: true, token: t });
  if (v.status !== 200 || v.json.result?.status !== "active") die(`token rejected: ${JSON.stringify(v.json.errors ?? v.json)}`);
  TOKEN = t;
  credSet("api-token", t);
  ok(`token ${redact(t)} verified and stored`);
}

async function probeToken() {
  step("Token permission probe");
  const zones = await cf("GET", `/zones?name=${ZONE}`, undefined, { raw: true });
  if (zones.status !== 200 || !zones.json.result?.length) die(`token cannot read zone ${ZONE} (needs Zone: Read on howdynet.io)`);
  const zoneId = zones.json.result[0].id;
  const accountId = zones.json.result[0].account?.id;
  const acct = isAccountToken();
  const checks = [
    // [permission name, path, required?]
    // Names mirror the token editor: Group > Permission > Level.
    ["User > User Details > Read (shows who runs this; optional)", "/user", false],
    [acct ? "Account > Account API Tokens > Edit (R2 state creds)" : "User > API Tokens > Edit (R2 state creds)", acct ? `/accounts/${accountId}/tokens/permission_groups` : "/user/tokens/permission_groups", !flags.localState],
    ["Account > Account Settings > Edit", `/accounts/${accountId}/members?per_page=1`, true],
    ["Zone > Zone Settings > Edit", `/zones/${zoneId}/settings/security_header`, true],
    ["Zone > DNS > Edit", `/zones/${zoneId}/dns_records?per_page=1`, true],
    ["Zone > Bot Management > Edit", `/zones/${zoneId}/bot_management`, true],
    ["Account > Access: Apps and Policies > Edit", `/accounts/${accountId}/access/apps?per_page=1`, true],
    ["Account > Turnstile > Edit", `/accounts/${accountId}/challenges/widgets?per_page=1`, true],
    ["Account > Workers Scripts > Edit", `/accounts/${accountId}/workers/scripts`, true],
    ["Account > Workers KV Storage > Edit", `/accounts/${accountId}/storage/kv/namespaces?per_page=1`, true],
    ["Account > Workers R2 Storage > Edit", `/accounts/${accountId}/r2/buckets?per_page=1`, !flags.localState],
    ["Account > Cloudflare Pages > Edit", `/accounts/${accountId}/pages/projects?per_page=1`, true],
    ["Account > Email Routing Addresses > Edit", `/accounts/${accountId}/email/routing/addresses?per_page=1`, true],
    ["Zone > SSL and Certificates > Edit", `/zones/${zoneId}/ssl/certificate_packs?per_page=1`, true],
    ["Zone > Single Redirect > Edit (apex redirect; needed by `howdy apex`)", `/zones/${zoneId}/rulesets?per_page=1`, false],
    ["Account > Cloudflare Tunnel > Edit (apex move; needed only if the portal rides a tunnel)", `/accounts/${accountId}/cfd_tunnel?per_page=1&is_deleted=false`, false],
  ];
  if (acct) checks.shift(); // account-owned tokens have no /user
  const missing = [];
  for (const [name, p, required] of checks) {
    const r = await cf("GET", p, undefined, { raw: true });
    if (r.status === 200) ok(name);
    else { (required ? warn : skip)(`${name}: HTTP ${r.status}`); if (required) missing.push(name); }
  }
  if (missing.length) {
    log("");
    log(`  The token is missing: ${c("1", missing.join(", "))}`);
    log("  Fix (no need to recreate the token): dash.cloudflare.com > My Profile > API Tokens > (this token) > Edit.");
    log("  Under Permissions click \"+ Add more\"; the three dropdowns are Group (User / Account / Zone), Permission, Level.");
    log("  Set exactly the Group > Permission > Level shown above, then \"Continue to summary\" and \"Update token\". Re-run.");
    if (missing.length === 1 && missing[0].includes("API Tokens"))
      log(`  Alternative: ./howdy up --local-state keeps Terraform state on disk and does not need that permission.`);
    die("token permissions incomplete");
  }
}

async function stepTwoFactor(d) {
  step("Two-factor authentication");
  if (!d.members.length) { warn("could not list account members; not enforcing 2FA this run"); return false; }
  if (d.all2fa) { ok(`all ${d.members.length} account member(s) have 2FA; enforcing account-wide`); return true; }
  todo(`enable 2FA for: ${d.membersWithout2fa.join(", ")} (dash.cloudflare.com > My Profile > Authentication). Re-run ./howdy up afterwards to enforce it account-wide.`);
  remember("Enable 2FA for every account member, then re-run ./howdy up");
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
  if (keyId && secret) {
    if (flags.dryRun) { skip("R2 S3 credentials present (not verified in dry-run)"); return { keyId, secret }; }
    const st = await r2WaitForCreds(d.accountId, keyId, secret, { attempts: 3 });
    if (st === 200) { ok("stored R2 S3 credentials accepted"); return { keyId, secret }; }
    warn(`stored R2 S3 credentials rejected (HTTP ${st}); getting new ones`);
    keyId = secret = null;
  }
  const tokensBase = isAccountToken() ? `/accounts/${d.accountId}/tokens` : "/user/tokens";
  const groups = await cf("GET", `${tokensBase}/permission_groups`);
  const g = groups.find((x) => x.name === "Workers R2 Storage Write") ?? groups.find((x) => /R2/.test(x.name) && /Write|Edit/.test(x.name) && (x.scopes ?? []).includes("com.cloudflare.api.account"));
  if (!g) die("could not find the 'Workers R2 Storage Write' permission group");
  const tok = await cf("POST", tokensBase, {
    name: `${BUCKET} (terraform state, created by howdy)`,
    policies: [{ effect: "allow", resources: { [`com.cloudflare.api.account.${d.accountId}`]: "*" }, permission_groups: [{ id: g.id, name: g.name }] }],
  });
  if (tok.dryRun) return { keyId: "dry", secret: "dry" };
  keyId = tok.id;
  secret = createHash("sha256").update(tok.value).digest("hex");
  ok(`minted API token ${tok.id} with ${g.name}; Access Key = token id, Secret = sha256(token value)`);
  const st = await r2WaitForCreds(d.accountId, keyId, secret);
  if (st === 200) {
    credSet("r2-access-key-id", keyId);
    credSet("r2-secret-access-key", secret);
    ok("R2 accepted the minted credentials");
    return { keyId, secret };
  }
  warn(`R2 still rejects the minted credentials (HTTP ${st}); deleting that token and falling back to a dashboard-created one`);
  await cfTry("DELETE", `${tokensBase}/${tok.id}`);
  return r2PromptForCreds(d);
}

async function r2PromptForCreds(d) {
  log(`
  Create R2 credentials in the dashboard (one minute):
    dash.cloudflare.com > R2 Object Storage > Manage R2 API Tokens > Create API token
    Name: ${BUCKET}   Permissions: Object Read & Write   Specify bucket: ${BUCKET}   TTL: forever
  The page then shows "Access Key ID" and "Secret Access Key". Paste them here.
  (Or stop and run ./howdy up --local-state to keep Terraform state on this Mac instead.)
`);
  const keyId = await ask("  Access Key ID: ");
  const secret = await askHidden("  Secret Access Key (input hidden): ");
  if (!keyId || !secret) die("no R2 credentials given");
  const st = await r2WaitForCreds(d.accountId, keyId, secret, { attempts: 6 });
  if (st !== 200) die(`R2 rejected those credentials too (HTTP ${st}). Check the bucket name and permission, or use --local-state.`);
  credSet("r2-access-key-id", keyId);
  credSet("r2-secret-access-key", secret);
  ok("R2 accepted the credentials");
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
    TF_VAR_apex_redirect: loadLocal().apexRedirect ? "true" : "false",
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
  const init = run("terraform", ["init", "-input=false", "-reconfigure", "-no-color", ...(flags.localState ? [] : backendArgs(d, r2))], { cwd: TF_DIR, env });
  if (init.status !== 0) die("terraform init failed (see above). The R2 credentials were verified moments ago, so this is most likely a transient error: re-run ./howdy up.");
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
  else { fs.writeFileSync(file, patchKvId(jsonc, id)); ok("wrote KV id into site/wrangler.jsonc; commit it before your next git pull (git add site/wrangler.jsonc && git commit -m \"Set KV namespace id\")"); }
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
  if (!flags.dryRun) {
    if (!fs.existsSync(GENERATED_CONFIG)) die("site/dist/server/wrangler.json missing: run the build first (./howdy site)");
    fs.writeFileSync(PREVIEW_CONFIG, previewConfig(fs.readFileSync(GENERATED_CONFIG, "utf8")));
  }
  const r = wrangler(["deploy", "-c", "dist/server/wrangler.preview.json"]);
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
  if (!flags.dryRun && !fs.existsSync(GENERATED_CONFIG)) die("site/dist/server/wrangler.json missing: run ./howdy site first");
  const dep = wrangler(["deploy", "-c", "dist/server/wrangler.json"]);
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
    APEX_REDIRECT: loadLocal().apexRedirect ? "true" : "false",
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
  await probeToken();
  const d = await discover();
  printStatus(d);
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
  await probeToken();
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
  const enforce2fa = d.all2fa;
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
  const keys = { sitekey: tfOutput("turnstile_sitekey", d, r2, d.all2fa), secret: tfOutput("turnstile_secret", d, r2, d.all2fa) };
  await stepGithub(d, r2, keys, d.all2fa, !!(d.workerDomain && d.workerDomain.service === WORKER));
}

// ---------------------------------------------------------------------------------- apex: move the internal portal, redirect bare domain to www
async function discoverApex(d) {
  const a = {};
  const apps = (await cf("GET", `/accounts/${d.accountId}/access/apps?per_page=100`)) ?? [];
  a.apexApps = apps.filter((x) => x.domain === ZONE || (x.self_hosted_domains ?? []).includes(ZONE) || (x.destinations ?? []).some((t) => t.uri === ZONE));
  a.bypassApps = apps.filter((x) => (x.domain ?? "").startsWith(`${ZONE}/`));
  const recs = await cf("GET", `/zones/${d.zoneId}/dns_records?name=${ZONE}&per_page=50`);
  a.apexRecords = recs.filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
  const portalRecs = await cf("GET", `/zones/${d.zoneId}/dns_records?name=${flags.portalHost}&per_page=10`);
  a.portalRecords = portalRecs.filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
  a.tunnels = [];
  const tunnels = (await cfTry("GET", `/accounts/${d.accountId}/cfd_tunnel?is_deleted=false&per_page=100`)) ?? [];
  for (const t of tunnels) {
    const cfg = await cfTry("GET", `/accounts/${d.accountId}/cfd_tunnel/${t.id}/configurations`);
    const ingress = cfg?.config?.ingress ?? [];
    if (ingress.some((i) => i.hostname === ZONE)) a.tunnels.push({ id: t.id, name: t.name, config: cfg.config });
  }
  return a;
}

async function cmdApex() {
  await stepToolchain();
  await stepToken();
  const d = await discover();
  const portal = flags.portalHost;
  step(`Bare domain: move the internal portal to ${portal}, then redirect ${ZONE} -> ${WWW}`);
  if (portal === WWW || portal === ZONE) die("--portal-host must be a different hostname");
  const a = await discoverApex(d);
  log(`  Access app(s) on ${ZONE}: ${a.apexApps.length ? a.apexApps.map((x) => `${x.name} (${x.domain})`).join(", ") : "none"}`);
  log(`  DNS on ${ZONE}: ${a.apexRecords.map((r) => `${r.type} ${r.content}${r.proxied ? " (proxied)" : ""}`).join(", ") || "none"}`);
  log(`  Tunnel(s) routing ${ZONE}: ${a.tunnels.map((t) => t.name).join(", ") || "none"}`);
  log(`  DNS on ${portal}: ${a.portalRecords.map((r) => `${r.type} ${r.content}`).join(", ") || "none"}`);
  if (a.portalRecords.length && a.apexApps.length === 0 && loadLocal().apexRedirect) { ok("already moved and redirect enabled"); return; }

  if (a.apexApps.length === 0 && a.portalRecords.length === 0) {
    warn(`no Access app found on ${ZONE}; nothing to move. If the login page still shows on the bare domain, the app may use a hostname pattern; check Zero Trust > Access > Applications.`);
  }
  const tunnelBound = a.tunnels.length > 0;
  const cnameTunnel = a.apexRecords.find((r) => r.type === "CNAME" && /\.cfargotunnel\.com$/.test(r.content));
  if (!tunnelBound) {
    warn(`could not find a Cloudflare Tunnel ingress for ${ZONE}. The portal's own hostname binding (Cloudflare OS workspace / Multi-Frames settings) must be changed to ${portal} by hand; this command still moves DNS and the Access app.`);
    remember(`Point the Multi-Frames portal (workspace multi-frames-cloud) at ${portal} in its own settings`);
  }
  log("");
  log("  Plan:");
  log(`    1. DNS: create ${portal} as a copy of the ${ZONE} record (${a.apexRecords[0]?.type ?? "?"} ${a.apexRecords[0]?.content ?? "?"}, proxied)`);
  if (tunnelBound) log(`    2. Tunnel: rename ingress hostname ${ZONE} -> ${portal} in ${a.tunnels.map((t) => t.name).join(", ")}`);
  log(`    3. Access: point ${a.apexApps.map((x) => x.name).join(", ") || "the portal app"} at ${portal}`);
  log(`    4. Terraform: enable the ${ZONE} -> ${WWW} redirect rule`);
  log(`    Unchanged: ${a.bypassApps.map((x) => x.domain).join(", ") || "n/a"} (security.txt bypass), ${ZONE} DNS record, portal.howdynet.io`);
  if (!(await confirm("  Proceed?"))) die("aborted");

  // 1. DNS
  if (a.portalRecords.length) skip(`${portal} DNS exists`);
  else if (!a.apexRecords.length) die(`no A/AAAA/CNAME record on ${ZONE} to copy`);
  else {
    const src = a.apexRecords.find((r) => r.type === "CNAME") ?? a.apexRecords[0];
    await cf("POST", `/zones/${d.zoneId}/dns_records`, { type: src.type, name: portal, content: src.content, proxied: true, ttl: 1, comment: "Internal portal (moved off the apex by howdy)" });
    ok(`created ${src.type} ${portal} -> ${src.content}`);
  }
  // 2. Tunnel ingress
  for (const t of a.tunnels) {
    const config = JSON.parse(JSON.stringify(t.config));
    for (const i of config.ingress) if (i.hostname === ZONE) i.hostname = portal;
    await cf("PUT", `/accounts/${d.accountId}/cfd_tunnel/${t.id}/configurations`, { config });
    ok(`tunnel ${t.name}: ingress ${ZONE} -> ${portal}`);
  }
  // 3. Access app
  for (const app of a.apexApps) {
    // Send the app back whole, with only the hostname fields changed, so no other setting resets.
    const body = { ...app };
    for (const k of ["id", "uid", "aud", "created_at", "updated_at"]) delete body[k];
    body.domain = app.domain === ZONE ? portal : app.domain;
    if (app.self_hosted_domains) body.self_hosted_domains = app.self_hosted_domains.map((h) => (h === ZONE ? portal : h));
    if (app.destinations) body.destinations = app.destinations.map((t) => (t.uri === ZONE ? { ...t, uri: portal } : t));
    if (app.policies) body.policies = app.policies.map((pol) => (typeof pol === "string" ? pol : { id: pol.id, precedence: pol.precedence }));
    await cf("PUT", `/accounts/${d.accountId}/access/apps/${app.id}`, body);
    ok(`Access app ${app.name}: ${ZONE} -> ${portal}`);
  }
  // 4. Redirect via Terraform
  saveLocal({ apexRedirect: true, portalHost: portal });
  const r2 = flags.localState ? null : { keyId: credGet("r2-access-key-id") ?? process.env.R2_ACCESS_KEY_ID, secret: credGet("r2-secret-access-key") ?? process.env.R2_SECRET_ACCESS_KEY };
  await stepTerraform(d, r2, d.all2fa && d.enforce2faNow);
  // 5. Verify
  if (!flags.dryRun) {
    step("Verify");
    for (const [url, want] of [[`https://${ZONE}/`, "301 to www"], [`https://${portal}/`, "Access login"]]) {
      let line = "";
      try {
        const r = await fetch(url, { redirect: "manual" });
        const loc = r.headers.get("location") ?? "";
        line = `${r.status} ${loc}`;
        const good = want === "301 to www" ? r.status === 301 && loc.startsWith(`https://${WWW}/`) : r.status === 302 && loc.includes("cloudflareaccess.com");
        (good ? ok : warn)(`${url} -> ${line} (expected ${want})`);
      } catch (e) { warn(`${url}: ${e.message}`); }
    }
  }
  report();
}

function cmdSelftest() {
  const eq = (a, b, what) => { if (a !== b) { console.error(`FAIL ${what}\n  got:  ${a}\n  want: ${b}`); process.exitCode = 1; } else ok(what); };
  eq(buildDmarc('v=DMARC1; p=none; rua=mailto:postmaster@howdynet.io; fo=1'),
    "v=DMARC1; p=quarantine; pct=100; rua=mailto:postmaster@howdynet.io; fo=1", "dmarc: upgrade p=none");
  eq(buildDmarc('"v=DMARC1; p=none; rua=mailto:abc@dmarc-reports.cloudflare.net; adkim=s"'),
    "v=DMARC1; p=quarantine; pct=100; rua=mailto:abc@dmarc-reports.cloudflare.net,mailto:postmaster@howdynet.io; fo=1; adkim=s", "dmarc: keep cloudflare rua + adkim, strip quotes");
  eq(buildDmarc(undefined), "v=DMARC1; p=quarantine; pct=100; rua=mailto:postmaster@howdynet.io; fo=1", "dmarc: missing record");
  const h = sigV4Headers({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/", query: { "max-keys": "2", prefix: "J" },
    keyId: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1", service: "s3", now: new Date("2013-05-24T00:00:00Z") });
  eq(h.Authorization.includes("Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request") && h["x-amz-date"] === "20130524T000000Z" && /Signature=[0-9a-f]{64}$/.test(h.Authorization), true, "sigv4: shape, scope and date");
  eq(h.Authorization.split("Signature=")[1], REF_SIG, "sigv4: signature matches reference");
  const jsonc = fs.readFileSync(path.join(SITE, "wrangler.jsonc"), "utf8");
  eq(readKvId(patchKvId(jsonc, "abc123")), "abc123", "kv: patch + read id");
  const generated = JSON.stringify({ name: WORKER, main: "entry.mjs", assets: { directory: "../client", binding: "ASSETS" },
    routes: [{ pattern: WWW, custom_domain: true }], workers_dev: true, kv_namespaces: [{ binding: "FORM_SUBMISSIONS", id: "x" }], send_email: [{ name: "EMAIL" }] });
  const prev = JSON.parse(previewConfig(generated));
  eq("routes" in prev, false, "preview: routes removed");
  eq(prev.main === "entry.mjs" && prev.assets.directory === "../client" && prev.kv_namespaces.length === 1 && prev.send_email.length === 1 && prev.workers_dev === true, true, "preview: everything else kept");
  let threw = false; try { previewConfig('{"name":"x"}'); } catch { threw = true; } eq(threw, true, "preview: rejects a non-generated config");
}

function help() {
  log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

const commands = { up: cmdUp, setup: stepToken, status: cmdStatus, infra: cmdInfra, site: cmdSite, cutover: cmdCutover, apex: cmdApex, github: cmdGithub, selftest: cmdSelftest, help };
if (!commands[cmd]) { help(); die(`unknown command: ${cmd}`); }
try {
  await commands[cmd]();
} catch (e) {
  die(e.message);
}
