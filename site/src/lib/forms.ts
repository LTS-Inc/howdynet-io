// Field whitelist per form (names match the HTML) and a plain-text formatter for the notification mail.

export const FORMS: Record<string, readonly string[]> = {
  contact: ["first-name", "last-name", "email", "phone", "service", "message"],
  "custom-quote": ["first-name", "last-name", "email", "phone", "company", "locations", "services", "timeline", "notes"],
  "network-results": [
    "first-name", "last-name", "email", "phone", "company",
    "quality-score", "latency", "jitter", "bufferbloat", "isp-speed", "effective-rate",
    "device", "os-browser", "connection-type", "screen", "location", "isp-detected", "timestamp",
  ],
};

export type Fields = Record<string, string | string[]>;

const MAX_LEN = 4000;

export function pick(data: FormData, allowed: readonly string[]): Fields {
  const out: Fields = {};
  for (const key of allowed) {
    const all = data.getAll(key).filter((v): v is string => typeof v === "string").map((v) => v.trim().slice(0, MAX_LEN));
    if (all.length === 0) continue;
    out[key] = all.length === 1 ? all[0] : all;
  }
  return out;
}

export function isEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

export function formatText(form: string, fields: Fields, id: string, meta: { ip?: string; ua?: string | null }): string {
  const lines = [`New ${form} submission from www.howdynet.io`, "", ];
  for (const [k, v] of Object.entries(fields)) {
    lines.push(`${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  }
  lines.push("", `id: ${id}`, `ip: ${meta.ip ?? "unknown"}`, `user-agent: ${meta.ua ?? "unknown"}`);
  return lines.join("\n");
}
