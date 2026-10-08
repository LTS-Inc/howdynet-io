// Serves images uploaded on /admin (stored in KV under media/<slot>).
export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { IMAGE_SLOTS, MEDIA_PREFIX } from "../../lib/settings";

export const GET: APIRoute = async ({ params }) => {
  const slot = params.slot ?? "";
  if (!(IMAGE_SLOTS as readonly string[]).includes(slot)) return new Response("Not found", { status: 404 });
  const { value, metadata } = await env.FORM_SUBMISSIONS.getWithMetadata<{ type?: string }>(MEDIA_PREFIX + slot, "arrayBuffer");
  if (!value) return new Response("Not found", { status: 404 });
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.type ?? "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
