// @ts-check
import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://www.howdynet.io",
  // Fully prerendered except src/pages/api/form.ts (prerender = false).
  output: "static",
  // No server sessions; prevents the adapter from requiring a SESSION KV binding.
  session: false,
  adapter: cloudflare({ imageService: "compile" }),
  integrations: [sitemap()],
  // privacy.html / terms.html -> served at /privacy and /terms by Workers static assets.
  build: { format: "file" },
});
