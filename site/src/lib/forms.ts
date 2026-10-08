// One contact schema for every form on the site, plus normalisation of the two legacy form names
// (custom-quote, network-results) so an old cached page can still submit.

export const NEEDS = ["coverage", "internet", "managed", "ranchhand", "quote", "other"] as const;
export type Need = (typeof NEEDS)[number];
export const NEED_LABELS: Record<Need, string> = {
  coverage: "Coverage check",
  internet: "Business internet",
  managed: "Managed IT & LAN",
  ranchhand: "RanchHand",
  quote: "Custom quote",
  other: "Something else",
};

export const CONTACT_FIELDS = ["name", "email", "phone", "company", "need", "address", "message", "page"] as const;
export const TEST_FIELDS = [
  "quality-score", "latency", "jitter", "bufferbloat", "isp-speed", "effective-rate",
  "device", "os-browser", "connection-type", "screen", "location", "isp-detected", "timestamp", "path",
] as const;

const LEGACY: Record<string, readonly string[]> = {
  "custom-quote": ["first-name", "last-name", "email", "phone", "company", "locations", "services", "timeline", "notes"],
  "network-results": ["first-name", "last-name", "email", "phone", "company", ...TEST_FIELDS],
  contact: ["first-name", "last-name", "email", "phone", "service", "message"],
};

export type Fields = Record<string, string>;

const MAX_LEN = 4000;

function take(data: FormData, key: string): string | undefined {
  const all = data.getAll(key).filter((v): v is string => typeof v === "string").map((v) => v.trim().slice(0, MAX_LEN)).filter(Boolean);
  return all.length ? all.join(", ") : undefined;
}

export interface Submission {
  form: "contact";
  fields: Fields;
  test: Fields;
}

/** Whitelist and normalise a submission. Returns null for an unknown form name. */
export function normalise(data: FormData): Submission | null {
  const form = String(data.get("form-name") ?? "contact");
  const fields: Fields = {};
  const test: Fields = {};
  if (form === "contact" && !data.has("first-name")) {
    for (const k of CONTACT_FIELDS) {
      const v = take(data, k);
      if (v) fields[k] = v;
    }
  } else if (LEGACY[form]) {
    const legacy: Fields = {};
    for (const k of LEGACY[form]) {
      const v = take(data, k);
      if (v) legacy[k] = v;
    }
    const name = [legacy["first-name"], legacy["last-name"]].filter(Boolean).join(" ");
    if (name) fields.name = name;
    for (const k of ["email", "phone", "company"] as const) if (legacy[k]) fields[k] = legacy[k];
    fields.need = form === "custom-quote" ? "quote" : form === "network-results" ? "other" : "other";
    const extra: string[] = [];
    for (const [k, v] of Object.entries(legacy)) {
      if (["first-name", "last-name", "email", "phone", "company"].includes(k)) continue;
      if ((TEST_FIELDS as readonly string[]).includes(k)) continue;
      extra.push(`${k}: ${v}`);
    }
    if (extra.length) fields.message = extra.join("\n");
    fields.page = `legacy:${form}`;
  } else {
    return null;
  }
  for (const k of TEST_FIELDS) {
    const v = take(data, k);
    if (v) test[k] = v;
  }
  if (fields.need && !(NEEDS as readonly string[]).includes(fields.need)) fields.need = "other";
  return { form: "contact", fields, test };
}

export function isEmail(v: unknown): v is string {
  return typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254;
}

export function subjectFor(s: Submission): string {
  const need = NEED_LABELS[(s.fields.need as Need) ?? "other"] ?? "Contact";
  let subject = `[howdynet.io] ${need}: ${s.fields.name ?? "unknown"}`;
  if (s.test["quality-score"]) subject += ` · network test ${s.test["quality-score"]}/100`;
  return subject;
}

export function formatText(s: Submission, id: string, meta: { ip?: string; ua?: string | null }): string {
  const lines = ["New contact from www.howdynet.io", ""];
  for (const [k, v] of Object.entries(s.fields)) lines.push(`${k}: ${v}`);
  if (Object.keys(s.test).length) {
    lines.push("", "Network test results:");
    for (const [k, v] of Object.entries(s.test)) lines.push(`  ${k}: ${v}`);
  }
  lines.push("", `id: ${id}`, `ip: ${meta.ip ?? "unknown"}`, `user-agent: ${meta.ua ?? "unknown"}`);
  return lines.join("\n");
}
