// Saves the admin form: text settings, feature flags, prices and image uploads.
export const prerender = false;

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { forbidden, verifyAdmin } from "../../../lib/access";
import { IMAGE_SLOTS, IMAGE_TYPES, MAX_IMAGE_BYTES, MEDIA_PREFIX, fromForm, getSettings, saveSettings } from "../../../lib/settings";

export const POST: APIRoute = async ({ request, redirect }) => {
  const email = await verifyAdmin(request);
  if (!email) return forbidden();

  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    return new Response("Bad form", { status: 400 });
  }

  const current = await getSettings(env.FORM_SUBMISSIONS, true);
  const next = fromForm(data, current);
  const problems: string[] = [];

  for (const slot of IMAGE_SLOTS) {
    if (data.get(`images.${slot}.remove`)) {
      await env.FORM_SUBMISSIONS.delete(MEDIA_PREFIX + slot);
      next.images[slot].src = "";
      continue;
    }
    const file = data.get(`images.${slot}.file`);
    if (!(file instanceof File) || file.size === 0) continue;
    if (!IMAGE_TYPES.includes(file.type)) { problems.push(`${slot}: ${file.type || "unknown type"} is not an image we accept`); continue; }
    if (file.size > MAX_IMAGE_BYTES) { problems.push(`${slot}: ${(file.size / 1024 / 1024).toFixed(1)} MB is over the 2 MB limit`); continue; }
    await env.FORM_SUBMISSIONS.put(MEDIA_PREFIX + slot, await file.arrayBuffer(), { metadata: { type: file.type, name: file.name } });
    next.images[slot].src = `/media/${slot}?v=${Date.now().toString(36)}`;
  }

  next.updatedAt = new Date().toISOString();
  next.updatedBy = email;
  await saveSettings(env.FORM_SUBMISSIONS, next);

  const q = new URLSearchParams({ saved: "1" });
  if (problems.length) q.set("problems", problems.join("; "));
  return redirect(`/admin?${q}`, 303);
};
