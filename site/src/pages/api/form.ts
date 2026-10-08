// Form delivery endpoint. Flow: honeypot -> Turnstile siteverify -> normalise/whitelist -> KV (always)
// -> email (best effort). Accepts the single contact form and the two legacy form names.
export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { formatText, isEmail, normalise, subjectFor } from "../../lib/forms";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TO = "support@howdynet.io";
const FROM = { email: "forms@mail.howdynet.io", name: "HowdyNET website" };
const DONE = "/about?sent=1#contact";

const baseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...baseHeaders, "Content-Type": "application/json" } });
}

function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

interface SiteverifyResult { success: boolean; hostname?: string; "error-codes"?: string[] }

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

  const sub = normalise(data);
  if (!sub) return json({ ok: false, error: "Unknown form." }, 400);

  // Honeypot: bots fill the hidden "website" field. Pretend success, deliver nothing.
  if (data.get("website")) return wantsJson(request) ? json({ ok: true }) : redirect();

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
    return json({ ok: false, error: "Verification failed. Please try again." }, 403);
  }

  if (!sub.fields.name) return json({ ok: false, error: "Please tell us your name." }, 400);
  if (!isEmail(sub.fields.email)) return json({ ok: false, error: "Please enter a valid business email." }, 400);

  const id = `contact/${new Date().toISOString()}-${crypto.randomUUID()}`;
  const ua = request.headers.get("user-agent");
  await env.FORM_SUBMISSIONS.put(id, JSON.stringify({ form: sub.form, ip, ua, fields: sub.fields, test: sub.test }), { expirationTtl: 60 * 60 * 24 * 365 });

  try {
    await env.EMAIL.send({
      to: TO,
      from: FROM,
      replyTo: sub.fields.email,
      subject: subjectFor(sub),
      text: formatText(sub, id, { ip, ua }),
    });
  } catch (err) {
    // Submission is already persisted in KV; do not fail the user.
    console.error("email send failed", id, err);
  }

  return wantsJson(request) ? json({ ok: true, id }) : redirect();
};

function redirect(): Response {
  return new Response(null, { status: 303, headers: { ...baseHeaders, Location: DONE } });
}

export const GET: APIRoute = () =>
  new Response("Method Not Allowed", { status: 405, headers: { ...baseHeaders, Allow: "POST" } });
