// Secrets are not emitted by `wrangler types` unless a .dev.vars file exists; declare them here.
declare namespace Cloudflare {
  interface Env {
    TURNSTILE_SECRET: string;
  }
}
