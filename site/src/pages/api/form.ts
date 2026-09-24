// Form delivery endpoint for the three site forms (contact, custom-quote, network-results).
// Flow: honeypot -> Turnstile siteverify -> whitelist fields -> KV (always) -> email (best effort).
export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { FORMS, formatText, isEmail, pick } from "../../lib/forms";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TO = "support@howdynet.io";
const FROM = { email: "forms@mail.howdynet.io", name: "HowdyNET website" };

const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, "Content-Type": "application/json" } });
}

function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

interface SiteverifyResult {
  success: boolean;
  hostname?: string;
  "error-codes"?: string[];
}

async function verifyTurnstile(token: string, ip?: string): Promise<SiteverifyResult> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return { success: false, "error-codes": ["missing-input-secret"] };
  const res = await fetch(SITEVERIFY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, response: token, remoteip: ip }),
  });
  if (!res.ok) return { success: false, "error-codes": [`siteverify-http-${res.status}`] };
  return (await res.json()) as SiteverifyResult;
}

export const POST: APIRoute = async ({ request }) => {
  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    return json({ ok: false, error: "Invalid form submission." }, 400);
  }

  const form = String(data.get("form-name") ?? "");
  const allowed = FORMS[form];
  if (!allowed) return json({ ok: false, error: "Unknown form." }, 400);

  // Honeypot: bots fill the hidden "website" field. Pretend success, deliver nothing.
  if (data.get("website")) return wantsJson(request) ? json({ ok: true }) : redirectBack(form);

  const ip = request.headers.get("cf-connecting-ip") ?? undefined;
  const token = String(data.get("cf-turnstile-response") ?? "");
  if (!token) return json({ ok: false, error: "Please complete the verification and try again." }, 400);

  const verify = await verifyTurnstile(token, ip);
  const host = verify.hostname ?? "";
  // Cloudflare's documented test secrets (1x…/2x…/3x…) always report hostname "example.com".
  const testKeys = /^[123]x0+AA$/.test(env.TURNSTILE_SECRET ?? "");
  const hostOk = testKeys || /(^|\.)howdynet\.io$/.test(host);
  if (!verify.success || !hostOk) {
    console.warn("turnstile rejected", verify["error-codes"], host);
    return json({ ok: false, error: "Verification failed — please try again." }, 403);
  }

  const fields = pick(data, allowed);
  if (!isEmail(fields.email)) return json({ ok: false, error: "Please enter a valid business email." }, 400);

  const id = `${form}/${new Date().toISOString()}-${crypto.randomUUID()}`;
  const ua = request.headers.get("user-agent");
  await env.FORM_SUBMISSIONS.put(id, JSON.stringify({ form, ip, ua, fields }), { expirationTtl: 60 * 60 * 24 * 365 });

  try {
    await env.EMAIL.send({
      to: TO,
      from: FROM,
      replyTo: fields.email,
      subject: `[howdynet.io] ${form}: ${fields["first-name"] ?? ""} ${fields["last-name"] ?? ""}`.trim(),
      text: formatText(form, fields, id, { ip, ua }),
    });
  } catch (err) {
    // Submission is already persisted in KV; do not fail the user.
    console.error("email send failed", id, err);
  }

  return wantsJson(request) ? json({ ok: true, id }) : redirectBack(form);
};

function redirectBack(form: string): Response {
  return new Response(null, { status: 303, headers: { ...baseHeaders, Location: `/?sent=${encodeURIComponent(form)}#contact` } });
}

export const GET: APIRoute = () =>
  new Response("Method Not Allowed", { status: 405, headers: { ...baseHeaders, Allow: "POST" } });
