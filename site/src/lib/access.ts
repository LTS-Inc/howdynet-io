// Cloudflare Access verification for /admin. Access sits in front of the path (Terraform:
// terraform/admin.tf) and adds a Cf-Access-Jwt-Assertion header to every request it lets
// through. The Worker checks that token itself, so the admin routes stay closed even if the
// Access application were removed.
import { env as workerEnv } from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

interface AccessEnv {
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ADMIN_EMAILS?: string;
  ACCESS_DEV_BYPASS_EMAIL?: string;
}

// Worker vars (ACCESS_AUD, ACCESS_TEAM_DOMAIN, ADMIN_EMAILS) are written to wrangler.jsonc by
// `howdy admin`; ACCESS_DEV_BYPASS_EMAIL comes from .dev.vars locally. `wrangler types` emits
// them with literal types, so they are read through this interface rather than Cloudflare.Env.
const env = workerEnv as unknown as AccessEnv;

let jwks: { url: string; set: JWTVerifyGetKey } | null = null;

export function adminEmails(): string[] {
  return (env.ADMIN_EMAILS ?? "support@howdynet.io").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}


/** Returns the signed-in admin's email, or null when the request must be refused. */
export async function verifyAdmin(request: Request): Promise<string | null> {
  const allowed = adminEmails();
  // Local development only: wrangler dev has no Access in front of it. The variable lives in
  // .dev.vars (never deployed) and requests served by Cloudflare's edge always carry CF-Ray.
  if (env.ACCESS_DEV_BYPASS_EMAIL && !request.headers.get("cf-ray")) {
    const e = env.ACCESS_DEV_BYPASS_EMAIL.toLowerCase();
    return allowed.includes(e) ? e : null;
  }
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  const url = `${issuer}/cdn-cgi/access/certs`;
  if (!jwks || jwks.url !== url) jwks = { url, set: createRemoteJWKSet(new URL(url), { cacheMaxAge: 10 * 60 * 1000 }) };
  try {
    const { payload } = await jwtVerify(token, jwks.set, { issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"] });
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    return email && allowed.includes(email) ? email : null;
  } catch (err) {
    console.warn("access token rejected", (err as Error).message);
    return null;
  }
}

export function forbidden(): Response {
  return new Response("Forbidden. Sign in at /admin with an authorized Google account.", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
