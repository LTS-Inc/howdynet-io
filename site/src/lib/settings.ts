// Site settings edited on /admin and stored in KV (FORM_SUBMISSIONS, key "settings/site").
// Pages render on the Worker at request time and read these through getSettings(); DEFAULTS is
// what the site shows until something is saved, and anything missing from KV falls back to it.

export const FLAGS = ["game", "konami", "floatingHat", "promoPopup"] as const;
export type Flag = (typeof FLAGS)[number];

export const IMAGE_SLOTS = ["hero", "about", "promo", "testimonial-1", "testimonial-2", "testimonial-3"] as const;
export type ImageSlot = (typeof IMAGE_SLOTS)[number];

export interface ImageRef { src: string; alt: string }
export interface Testimonial { quote: string; name: string; title: string; company: string }
export interface Stat { value: string; label: string }

export interface SiteSettings {
  flags: Record<Flag, boolean>;
  contact: { phone: string; email: string; hours: string; hq: string; area: string };
  announcement: { enabled: boolean; text: string; linkText: string; href: string };
  promo: { title: string; body: string; ctaText: string; ctaHref: string };
  images: Record<ImageSlot, ImageRef>;
  testimonials: Testimonial[];
  stats: Stat[];
  pricing: {
    internet: { basic: number; standard: number; business: number };
    managed: { pos: number; complete: number; mspBasic: number; mspAdvanced: number };
    ranchhand: number;
    ranchhandDeposit: number;
  };
  updatedAt?: string;
  updatedBy?: string;
}

const emptyImage = (): ImageRef => ({ src: "", alt: "" });

export const DEFAULTS: SiteSettings = {
  flags: { game: false, konami: false, floatingHat: false, promoPopup: false },
  contact: {
    phone: "(512) 200-4744",
    email: "support@howdynet.io",
    hours: "Call or text, real humans answer",
    hq: "Austin, Texas",
    area: "US · Mexico · Canada · Europe",
  },
  announcement: { enabled: false, text: "", linkText: "", href: "" },
  promo: {
    title: "Free network check for new clients",
    body: "Book a visit this month and we review your Wi-Fi, internet and cameras at no charge.",
    ctaText: "Talk to us",
    ctaHref: "/about#contact",
  },
  images: {
    hero: emptyImage(), about: emptyImage(), promo: emptyImage(),
    "testimonial-1": emptyImage(), "testimonial-2": emptyImage(), "testimonial-3": emptyImage(),
  },
  testimonials: [
    { quote: "Most IT companies hand you a rack and leave. HowdyNET handed us a system that works and they are still on the line.", name: "[NAME]", title: "[TITLE]", company: "[COMPANY], multi-location operator, Austin" },
    { quote: "If it plugs in and doesn't work, I just say HowdyNET.", name: "[NAME]", title: "[TITLE]", company: "[COMPANY], restaurant, Austin" },
    { quote: "They keep the lights on, keep me in the loop, and only explain what I actually want to know.", name: "[NAME]", title: "[TITLE]", company: "[COMPANY], multi-location retail, Texas" },
  ],
  stats: [
    { value: "200+", label: "businesses served" },
    { value: "Month to month", label: "no multi-year contracts" },
    { value: "At cost", label: "hardware with no markup" },
    { value: "One number", label: "a person who knows your setup" },
  ],
  pricing: {
    internet: { basic: 79, standard: 149, business: 299 },
    managed: { pos: 99, complete: 199, mspBasic: 500, mspAdvanced: 1000 },
    ranchhand: 79,
    ranchhandDeposit: 199,
  },
};

export const SETTINGS_KEY = "settings/site";
export const MEDIA_PREFIX = "media/";
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/svg+xml"];

type KV = { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string): Promise<void> };

const CACHE_MS = 30_000;
let cache: { at: number; value: SiteSettings } | null = null;

/** Text fields: an empty or missing value means "use the default". Fields that may be empty are cleared explicitly in fromForm. */
function str(v: unknown, fallback: string, max = 2000): string {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fallback;
}
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : fallback;
}
function image(v: unknown, fallback: ImageRef): ImageRef {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const src = typeof o.src === "string" ? o.src.trim().slice(0, 1000) : fallback.src;
  const alt = typeof o.alt === "string" ? o.alt.trim().slice(0, 200) : fallback.alt;
  return { src: safeUrl(src), alt };
}
/** Only http(s) URLs and site-relative paths are allowed as image sources or links. */
export function safeUrl(v: string): string {
  if (!v) return "";
  if (/^\/(?!\/)/.test(v)) return v;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
  } catch {
    return "";
  }
}

/** Deep-merge raw JSON (from KV or a form) onto DEFAULTS, dropping anything malformed. */
export function normalize(raw: unknown): SiteSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const d = DEFAULTS;
  const flags = Object.fromEntries(FLAGS.map((f) => [f, bool(r.flags?.[f], d.flags[f])])) as Record<Flag, boolean>;
  const images = Object.fromEntries(IMAGE_SLOTS.map((s) => [s, image(r.images?.[s], d.images[s])])) as Record<ImageSlot, ImageRef>;
  const testimonials = d.testimonials.map((t, i) => {
    const o = r.testimonials?.[i] ?? {};
    return { quote: str(o.quote, t.quote, 600), name: str(o.name, t.name, 100), title: str(o.title, t.title, 100), company: str(o.company, t.company, 160) };
  });
  const stats = d.stats.map((s, i) => {
    const o = r.stats?.[i] ?? {};
    return { value: str(o.value, s.value, 40), label: str(o.label, s.label, 80) };
  });
  return {
    flags,
    contact: {
      phone: str(r.contact?.phone, d.contact.phone, 40),
      email: str(r.contact?.email, d.contact.email, 120),
      hours: str(r.contact?.hours, d.contact.hours, 120),
      hq: str(r.contact?.hq, d.contact.hq, 80),
      area: str(r.contact?.area, d.contact.area, 120),
    },
    announcement: {
      enabled: bool(r.announcement?.enabled, d.announcement.enabled),
      text: typeof r.announcement?.text === "string" ? r.announcement.text.trim().slice(0, 200) : d.announcement.text,
      linkText: typeof r.announcement?.linkText === "string" ? r.announcement.linkText.trim().slice(0, 60) : d.announcement.linkText,
      href: safeUrl(typeof r.announcement?.href === "string" ? r.announcement.href.trim().slice(0, 500) : d.announcement.href),
    },
    promo: {
      title: str(r.promo?.title, d.promo.title, 120),
      body: str(r.promo?.body, d.promo.body, 500),
      ctaText: str(r.promo?.ctaText, d.promo.ctaText, 60),
      ctaHref: safeUrl(str(r.promo?.ctaHref, d.promo.ctaHref, 500)) || d.promo.ctaHref,
    },
    images,
    testimonials,
    stats,
    pricing: {
      internet: {
        basic: num(r.pricing?.internet?.basic, d.pricing.internet.basic),
        standard: num(r.pricing?.internet?.standard, d.pricing.internet.standard),
        business: num(r.pricing?.internet?.business, d.pricing.internet.business),
      },
      managed: {
        pos: num(r.pricing?.managed?.pos, d.pricing.managed.pos),
        complete: num(r.pricing?.managed?.complete, d.pricing.managed.complete),
        mspBasic: num(r.pricing?.managed?.mspBasic, d.pricing.managed.mspBasic),
        mspAdvanced: num(r.pricing?.managed?.mspAdvanced, d.pricing.managed.mspAdvanced),
      },
      ranchhand: num(r.pricing?.ranchhand, d.pricing.ranchhand),
      ranchhandDeposit: num(r.pricing?.ranchhandDeposit, d.pricing.ranchhandDeposit),
    },
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : undefined,
    updatedBy: typeof r.updatedBy === "string" ? r.updatedBy : undefined,
  };
}

/** Settings for a request. Cached in the isolate for 30 s; a KV outage falls back to DEFAULTS. */
export async function getSettings(kv: KV | undefined, fresh = false): Promise<SiteSettings> {
  if (!kv) return DEFAULTS;
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  let value = DEFAULTS;
  try {
    const raw = await kv.get(SETTINGS_KEY, "json");
    value = raw ? normalize(raw) : DEFAULTS;
  } catch (err) {
    console.error("settings read failed", err);
  }
  cache = { at: Date.now(), value };
  return value;
}

export async function saveSettings(kv: KV, settings: SiteSettings): Promise<void> {
  await kv.put(SETTINGS_KEY, JSON.stringify(settings));
  cache = null;
}

/** Build a settings object from the admin form's fields (names use dotted paths, e.g. "contact.phone"). */
export function fromForm(data: FormData, current: SiteSettings): SiteSettings {
  const get = (k: string) => {
    const v = data.get(k);
    return typeof v === "string" ? v : undefined;
  };
  const has = (k: string) => data.has(k);
  const raw: any = {
    flags: Object.fromEntries(FLAGS.map((f) => [f, has(`flags.${f}`)])),
    contact: { phone: get("contact.phone"), email: get("contact.email"), hours: get("contact.hours"), hq: get("contact.hq"), area: get("contact.area") },
    announcement: { enabled: has("announcement.enabled"), text: get("announcement.text"), linkText: get("announcement.linkText"), href: get("announcement.href") },
    promo: { title: get("promo.title"), body: get("promo.body"), ctaText: get("promo.ctaText"), ctaHref: get("promo.ctaHref") },
    images: Object.fromEntries(IMAGE_SLOTS.map((s) => [s, { src: get(`images.${s}.src`) ?? current.images[s].src, alt: get(`images.${s}.alt`) }])),
    testimonials: current.testimonials.map((_, i) => ({ quote: get(`testimonials.${i}.quote`), name: get(`testimonials.${i}.name`), title: get(`testimonials.${i}.title`), company: get(`testimonials.${i}.company`) })),
    stats: current.stats.map((_, i) => ({ value: get(`stats.${i}.value`), label: get(`stats.${i}.label`) })),
    pricing: {
      internet: { basic: get("pricing.internet.basic"), standard: get("pricing.internet.standard"), business: get("pricing.internet.business") },
      managed: { pos: get("pricing.managed.pos"), complete: get("pricing.managed.complete"), mspBasic: get("pricing.managed.mspBasic"), mspAdvanced: get("pricing.managed.mspAdvanced") },
      ranchhand: get("pricing.ranchhand"),
      ranchhandDeposit: get("pricing.ranchhandDeposit"),
    },
  };
  // Empty text fields mean "use the default"; image URLs and the announcement may be cleared.
  return normalize(raw);
}

export const money = (n: number): string => (Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
