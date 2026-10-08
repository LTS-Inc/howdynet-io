// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.howdynet.io",
  // Pages render on the Worker per request so the copy, images and prices edited on /admin
  // (stored in KV) show up without a rebuild. Legal pages and 404 opt back in to prerendering.
  output: "server",
  // No server sessions; prevents the adapter from requiring a SESSION KV binding.
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [sitemap({ filter: (page) => !page.includes("/admin") })],
  build: { format: "file" },
});
