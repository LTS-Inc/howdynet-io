// Loads the admin-managed site settings for every request and adds security headers to responses
// rendered by the Worker. Static assets get the same headers from public/_headers, which Workers
// Static Assets applies only to files it serves itself.
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { getSettings } from "./lib/settings";

const HEADERS: Record<string, string> = {
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "SAMEORIGIN",
  "X-Content-Type-Options": "nosniff",
};

export const onRequest = defineMiddleware(async (context, next) => {
  const kv = (env as Cloudflare.Env | undefined)?.FORM_SUBMISSIONS;
  context.locals.settings = await getSettings(kv, context.url.pathname.startsWith("/admin"));
  const response = await next();
  for (const [k, v] of Object.entries(HEADERS)) if (!response.headers.has(k)) response.headers.set(k, v);
  if (context.url.pathname.startsWith("/admin") || context.url.pathname.startsWith("/api/")) {
    response.headers.set("Cache-Control", "no-store");
  }
  return response;
});
