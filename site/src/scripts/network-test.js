// Browser network quality test: baseline latency, latency under load, jitter, bufferbloat and
// consistency scored out of 100. Results are kept in sessionStorage so /about can attach them.
const TEST_KEY = "howdynet.test";
const $ = (id) => document.getElementById(id);
const GOOD = "#22c55e", OK = "#facc15", BAD = "#ef4444";

const device = (() => {
  const ua = navigator.userAgent;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iOS" : "Linux";
  const br = /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : "Other";
  return {
    device: /Mobi|Android/i.test(ua) ? "Mobile" : /Tablet|iPad/.test(ua) ? "Tablet" : "Desktop",
    osBr: os + " / " + br,
    screen: window.screen.width + "x" + window.screen.height,
    conn: conn ? conn.effectiveType || conn.type || "unknown" : "unknown",
  };
})();
const geo = { loc: "Not detected", isp: "Not detected" };

let running = false;
let currentQS = null;
let last = null;

function setStep(s) {
  const all = ["idle", "baseline", "load", "grade", "done"];
  const ci = all.indexOf(s);
  all.forEach((id, i) => {
    const el = $("bstep-" + id);
    if (!el) return;
    el.className = "bstep" + (i === ci ? " active" : i < ci ? " done" : "");
  });
}

function ping(url) {
  return new Promise((resolve) => {
    const t = performance.now();
    const img = new Image();
    img.onload = img.onerror = () => resolve(performance.now() - t);
    img.src = url + "?_=" + Date.now() + Math.floor(Math.random() * 9999);
  });
}
async function pings(url, n, delay) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(await ping(url));
    await new Promise((r) => setTimeout(r, delay));
  }
  return out;
}
const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
function load(ms) {
  const end = Date.now() + ms;
  const urls = ["https://www.cloudflare.com/favicon.ico", "https://www.google.com/favicon.ico", "https://www.apple.com/favicon.ico"];
  (function fire() {
    if (Date.now() >= end) return;
    for (let i = 0; i < 6; i++) {
      const img = new Image();
      img.src = urls[i % 3] + "?b=" + Date.now() + Math.floor(Math.random() * 9999);
    }
    setTimeout(fire, 80);
  })();
}
function qsColor(n) {
  return n >= 85 ? "#22c55e" : n >= 70 ? "#4ade80" : n >= 55 ? "#a3e635" : n >= 40 ? "#facc15" : n >= 25 ? "#f97316" : "#ef4444";
}
function calcQS(bl, ld, jit) {
  const inc = Math.max(0, ld - bl);
  const latS = Math.max(0, Math.min(30, Math.round(30 * (1 - Math.min(1, (bl - 10) / 190)))));
  const jitS = Math.max(0, Math.min(20, Math.round(20 * (1 - Math.min(1, jit / 50)))));
  const bloatS = inc < 5 ? 35 : inc < 15 ? 30 : inc < 30 ? 22 : inc < 60 ? 14 : inc < 120 ? 6 : 0;
  const ratio = bl > 0 ? jit / bl : 1;
  const conS = Math.max(0, Math.min(15, Math.round(15 * (1 - Math.min(1, ratio * 3)))));
  return { total: latS + jitS + bloatS + conS, latS, jitS, bloatS, conS, con: Math.round(Math.max(0, 100 - ratio * 100)) };
}
function setBar(id, pts, max, color, desc) {
  const p = $("qsp-" + id), b = $("qsb-" + id), d = $("qsd-" + id);
  if (p) p.textContent = pts === null ? "" : pts + " / " + max;
  if (b) { b.style.width = (pts === null ? 0 : Math.round((pts / max) * 100)) + "%"; b.style.background = color; }
  if (d) d.textContent = desc;
}
function setMetric(id, text, color) {
  const el = $(id);
  if (el) { el.textContent = text; el.style.color = color || ""; }
}
function setRing(total, color) {
  const ring = $("qs-ring");
  if (ring) ring.style.background = "conic-gradient(" + color + " " + total + "%, rgba(26,159,224,0.2) 0)";
}

function updateEffRate() {
  const spd = parseFloat($("isp-speed").value);
  const el = $("b-eff-num"), desc = $("b-eff-desc");
  if (!el) return;
  if (!spd || spd <= 0) { el.textContent = "0"; if (desc) desc.textContent = "Enter the speed on your bill to see what you really get."; return; }
  if (currentQS === null) { el.textContent = "?"; if (desc) desc.textContent = "Run the test first to calculate your effective rate."; return; }
  const eff = Math.round(spd * (currentQS / 100));
  el.textContent = String(eff);
  el.style.color = currentQS >= 70 ? GOOD : currentQS >= 45 ? OK : BAD;
  const msg = currentQS < 50 ? "Less than half of what you are paying for." : currentQS < 75 ? "Quality issues are eating your bandwidth." : "Good efficiency. Your infrastructure is working.";
  if (desc) desc.textContent = "Paying for " + spd + " Mbps, real-world quality delivers " + eff + " Mbps. " + msg;
  if (last) { last["isp-speed"] = spd + " Mbps"; last["effective-rate"] = eff + " Mbps"; save(); }
}

const TRACE = [
  { hop: "Cloudflare DNS (1.1.1.1)", url: "https://1.1.1.1/favicon.ico" },
  { hop: "Google DNS (8.8.8.8)", url: "https://dns.google/favicon.ico" },
  { hop: "Cloudflare CDN edge", url: "https://www.cloudflare.com/favicon.ico" },
  { hop: "AWS us-east-1", url: "https://aws.amazon.com/favicon.ico" },
];
async function pathAnalysis() {
  const rows = await Promise.all(TRACE.map(async (t, idx) => {
    await new Promise((r) => setTimeout(r, idx * 50));
    const s = (await pings(t.url, 4, 80)).sort((a, b) => a - b);
    return { hop: t.hop, med: Math.round(s[s.length >> 1]), jitter: Math.round(s[s.length - 1] - s[0]) };
  }));
  return rows.map((r) => r.hop + ": " + r.med + "ms (jitter " + r.jitter + "ms)").join(" | ");
}

function save() {
  try { sessionStorage.setItem(TEST_KEY, JSON.stringify(last)); } catch (e) {}
  const form = $("b-send") && $("b-send").querySelector("form");
  if (form && last) {
    Object.keys(last).forEach((k) => {
      const input = form.querySelector('input[name="' + k + '"]');
      if (input) input.value = String(last[k]);
    });
  }
}

async function run() {
  if (running) return;
  running = true;
  const btn = $("b-run-btn");
  btn.disabled = true;
  btn.textContent = "Testing";
  $("b-explain").className = "b-explain";
  $("b-contact").className = "b-contact";
  $("b-send").classList.remove("show");
  ["b-baseline", "b-loaded", "b-jitter"].forEach((id) => setMetric(id, "0", "rgba(253,246,238,0.3)"));
  setMetric("qs-score", "0", "rgba(253,246,238,0.3)");
  setMetric("qs-verdict", "Testing", "rgba(253,246,238,0.5)");
  setRing(0, "#1A9FE0");
  ["lat", "jit", "bloat", "con"].forEach((id) => setBar(id, null, 0, "#1A9FE0", ""));
  $("b-status").textContent = "Measuring baseline latency.";
  setStep("baseline");

  const url = "https://www.cloudflare.com/favicon.ico";
  const base = await pings(url, 10, 130);
  const bl = median(base);
  const sorted = base.slice().sort((a, b) => a - b);
  const jit = Math.round((sorted[sorted.length - 1] - sorted[0]) * 0.55);
  setMetric("b-baseline", String(Math.round(bl)), "#6EC6F0");
  $("b-status").textContent = "Baseline " + Math.round(bl) + " ms. Loading the link.";
  setStep("load");
  load(4000);
  await new Promise((r) => setTimeout(r, 1500));
  const loaded = await pings(url, 10, 160);
  const ld = median(loaded);
  const inc = Math.max(0, ld - bl);
  setMetric("b-loaded", String(Math.round(ld)), inc > 60 ? BAD : inc > 20 ? OK : "#6EC6F0");
  setMetric("b-jitter", String(jit), jit > 20 ? "#f97316" : jit > 8 ? OK : GOOD);
  setStep("grade");
  $("b-status").textContent = "Calculating quality score.";
  await new Promise((r) => setTimeout(r, 400));

  const qs = calcQS(bl, ld, jit);
  const c = qsColor(qs.total);
  setStep("done");
  setRing(qs.total, c);
  setMetric("qs-score", String(qs.total), c);
  const verdict = qs.total >= 85 ? "Excellent" : qs.total >= 70 ? "Good" : qs.total >= 55 ? "Fair" : qs.total >= 40 ? "Poor" : "Critical";
  setMetric("qs-verdict", verdict, c);
  setBar("lat", qs.latS, 30, qs.latS >= 24 ? GOOD : qs.latS >= 15 ? OK : BAD, bl < 20 ? "Ideal for real-time apps" : bl < 50 ? "Good latency for business use" : "Higher than ideal, check your ISP");
  setBar("jit", qs.jitS, 20, qs.jitS >= 16 ? GOOD : qs.jitS >= 10 ? OK : BAD, jit < 5 ? "Rock solid, calls will be clear" : jit < 15 ? "Acceptable variance" : "High jitter, video calls will stutter");
  setBar("bloat", qs.bloatS, 35, qs.bloatS >= 28 ? GOOD : qs.bloatS >= 14 ? OK : BAD, inc < 15 ? "No bufferbloat, QoS is working" : inc < 60 ? "Moderate, noticeable under heavy use" : "Severe bufferbloat, hurting your team daily");
  setBar("con", qs.conS, 15, qs.conS >= 12 ? GOOD : qs.conS >= 8 ? OK : BAD, qs.con > 80 ? "Highly consistent connection" : qs.con > 60 ? "Mostly stable with some variance" : "Unstable, performance varies a lot");

  const explains = {
    A: "Minimal bufferbloat. Latency stayed stable under load, so video calls and real-time apps will perform reliably.",
    B: "Mild bufferbloat. Good most of the time, but heavy usage causes occasional quality dips. Fixable with proper QoS.",
    C: "Moderate bufferbloat. Latency jumps enough to cause choppy calls and sluggish apps under load.",
    D: "Significant bufferbloat. Your team is experiencing degraded performance daily, and this is likely the cause.",
    F: "Severe bufferbloat. Video calls fail and VoIP breaks. It needs intervention, and it is fixable.",
  };
  const grade = inc < 5 ? "A" : inc < 30 ? "B" : inc < 60 ? "C" : inc < 120 ? "D" : "F";
  $("b-explain-text").textContent = explains[grade] + " Baseline " + Math.round(bl) + " ms, loaded " + Math.round(ld) + " ms, " + Math.round(inc) + " ms added.";
  $("b-explain").className = "b-explain show";
  $("b-contact").className = "b-contact show";
  $("b-status").textContent = "Quality score " + qs.total + "/100.";
  btn.disabled = false;
  btn.textContent = "Run again";
  running = false;

  currentQS = qs.total;
  last = {
    "quality-score": qs.total, latency: Math.round(bl) + " ms", jitter: jit + " ms", bufferbloat: "+" + Math.round(inc) + " ms",
    device: device.device, "os-browser": device.osBr, "connection-type": device.conn, screen: device.screen,
    location: geo.loc, "isp-detected": geo.isp, timestamp: new Date().toISOString(), path: "Measuring",
  };
  updateEffRate();
  save();
  pathAnalysis().then((summary) => { if (last) { last.path = summary; save(); } });
}

if ($("b-run-btn")) {
  $("b-run-btn").addEventListener("click", run);
  $("isp-speed").addEventListener("input", updateEffRate);
  $("b-send-open").addEventListener("click", () => {
    $("b-send").classList.add("show");
    $("b-send").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  fetch("https://ipapi.co/json/").then((r) => r.json()).then((d) => {
    geo.loc = [d.city, d.region, d.country_name].filter(Boolean).join(", ");
    geo.isp = d.org || d.isp || "Unknown";
    if (last) { last.location = geo.loc; last["isp-detected"] = geo.isp; save(); }
  }).catch(() => {});
}
