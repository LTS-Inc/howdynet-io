// Optional extras switched on from /admin: hidden game, Konami code, floating hat, promo popup.
// Base.astro includes this module only when at least one flag is on, with the config in
// #howdy-extras. Everything (markup and styles) is created here so pages carry nothing otherwise.
const cfg = JSON.parse(document.getElementById("howdy-extras")?.textContent || "{}");
const flags = cfg.flags || {};
const COLORS = ["#E86A1A", "#F5956A", "#1A9FE0", "#6EC6F0", "#facc15", "#C85500", "#22c55e"];

const css = `
.x-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(60px);background:#8B2200;color:#FDF6EE;border-radius:100px;padding:12px 24px;font-size:.875rem;font-weight:800;z-index:9999;white-space:nowrap;transition:transform .4s cubic-bezier(.34,1.4,.64,1),opacity .4s;opacity:0;pointer-events:none;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.x-toast.show{transform:translateX(-50%) translateY(0);opacity:1}
.x-rain{position:fixed;inset:0;pointer-events:none;z-index:9998;overflow:hidden}
.x-fall{position:absolute;top:-80px;font-size:2.5rem;animation:x-fall linear forwards}
@keyframes x-fall{0%{transform:translateY(0) rotate(0);opacity:1}80%{opacity:1}100%{transform:translateY(110vh) rotate(360deg);opacity:0}}
@keyframes x-confetti{0%{opacity:1;transform:translateY(0) rotate(0) scale(1)}100%{opacity:0;transform:translateY(var(--ch,200px)) rotate(var(--cr,360deg)) scale(.3) translateX(var(--cx,0))}}
@keyframes x-spark{0%{opacity:1;transform:scale(1) translate(0,0)}100%{opacity:0;transform:scale(.2) translate(var(--sx,0),var(--sy,0))}}
#x-hat{position:fixed;font-size:2.2rem;cursor:pointer;z-index:8888;user-select:none;filter:drop-shadow(0 4px 12px rgba(0,0,0,.4));transition:transform .15s,filter .15s;line-height:1}
#x-hat:hover{filter:drop-shadow(0 6px 20px rgba(232,106,26,.6));transform:scale(1.2) rotate(-10deg)}
.x-konami{display:none;position:fixed;inset:0;z-index:9995;background:rgba(10,4,0,.96);align-items:center;justify-content:center;flex-direction:column;text-align:center;padding:24px;color:#FDF6EE}
.x-konami.show{display:flex}
.x-konami .t{font-size:clamp(2.5rem,6vw,5rem);font-weight:900;color:#E86A1A;letter-spacing:-.02em;text-shadow:0 0 60px rgba(232,106,26,.5);animation:x-pulse .8s ease-in-out infinite alternate}
@keyframes x-pulse{from{transform:scale(1)}to{transform:scale(1.04)}}
.x-konami .s{font-size:1rem;color:rgba(255,255,255,.6);margin-top:12px;max-width:520px}
.x-konami .s code{color:#6EC6F0}
.x-konami .x{position:absolute;top:16px;right:20px;background:none;border:0;color:rgba(255,255,255,.4);font-size:2rem;cursor:pointer;width:44px;height:44px}
.x-konami .x:hover{color:#FDF6EE}
.x-konami .btns{display:flex;gap:12px;margin-top:24px;flex-wrap:wrap;justify-content:center}
.x-tumble{position:fixed;font-size:3rem;animation:x-tumble linear forwards;pointer-events:none;z-index:9994}
@keyframes x-tumble{from{transform:translateX(-120px) rotate(0);opacity:1}to{transform:translateX(110vw) rotate(720deg);opacity:.6}}
.x-popup{display:none;position:fixed;inset:0;z-index:9999;background:rgba(10,4,0,.82);backdrop-filter:blur(8px);align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .35s}
.x-popup.show{display:flex;opacity:1}
.x-popup .box{background:#100500;color:#FDF6EE;border:1px solid rgba(255,255,255,.08);border-radius:20px;max-width:680px;width:100%;display:grid;grid-template-columns:200px 1fr;overflow:hidden;box-shadow:0 40px 80px rgba(0,0,0,.7);position:relative}
.x-popup .left{background:#8B2200;display:grid;place-items:center;padding:28px 20px}
.x-popup .left img{width:140px;height:140px;object-fit:cover;border-radius:16px;filter:drop-shadow(0 10px 24px rgba(0,0,0,.4))}
.x-popup .right{padding:32px 28px 24px}
.x-popup h2{font-size:1.5rem;font-weight:900;margin:0 0 12px;color:#FDF6EE}
.x-popup p{color:rgba(253,246,238,.78);margin:0 0 20px}
.x-popup .close{position:absolute;top:8px;right:8px;background:none;border:0;color:rgba(255,255,255,.5);font-size:1.6rem;cursor:pointer;width:44px;height:44px}
.x-popup .dismiss{display:block;background:none;border:0;color:rgba(253,246,238,.5);font:inherit;font-size:.875rem;margin-top:14px;cursor:pointer;padding:8px 0;text-decoration:underline}
@media (max-width:640px){.x-popup .box{grid-template-columns:1fr}.x-popup .left{padding:20px}.x-popup .left img{width:96px;height:96px}}
.x-game-btn{display:inline-flex;align-items:center;gap:8px;font:inherit;font-size:.875rem;font-weight:800;color:rgba(253,246,238,.6);background:none;border:1px solid rgba(255,255,255,.12);padding:10px 14px;border-radius:8px;cursor:pointer;margin-top:16px;min-height:44px}
.x-game-btn:hover{color:#E86A1A;border-color:rgba(232,106,26,.4)}
.x-game{display:none;position:fixed;inset:0;z-index:9990;background:rgba(10,4,0,.95);backdrop-filter:blur(12px);align-items:center;justify-content:center;flex-direction:column;gap:14px;padding:16px;color:#FDF6EE;text-align:center}
.x-game.open{display:flex}
.x-game .wrap{background:#061E35;border:1px solid rgba(26,159,224,.2);border-radius:16px;overflow:hidden;max-width:100%}
.x-game .ui{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:rgba(5,24,48,.9);font-weight:800;font-size:.9rem}
.x-game .ui span b{color:#E86A1A}
.x-game .ui .time{color:#1A9FE0}
.x-game .ui button{background:none;border:0;cursor:pointer;color:rgba(255,255,255,.5);font:inherit;font-weight:800;min-height:44px;padding:0 8px}
.x-game canvas{display:block;max-width:100%;height:auto;touch-action:none}
.x-game .intro{max-width:520px;color:rgba(253,246,238,.8)}
.x-game .intro b{display:block;font-size:1.25rem;color:#FDF6EE}
`;
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

function toast(msg) {
  const t = el("div", "x-toast", "");
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("show")));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 400); }, 2800);
}

function confetti(cx, cy, n) {
  for (let i = 0; i < n; i++) {
    setTimeout(() => {
      const p = el("div");
      const angle = (i / n) * Math.PI * 2, dist = 50 + Math.random() * 110;
      p.style.cssText = `position:fixed;width:9px;height:9px;border-radius:2px;pointer-events:none;z-index:9998;left:${cx}px;top:${cy}px;background:${COLORS[i % COLORS.length]};animation:x-confetti .75s ease-out forwards`;
      p.style.setProperty("--cx", Math.cos(angle) * dist + "px");
      p.style.setProperty("--ch", 80 + Math.random() * 140 + "px");
      p.style.setProperty("--cr", (Math.random() > 0.5 ? "" : "-") + (180 + Math.random() * 360) + "deg");
      document.body.appendChild(p);
      setTimeout(() => p.remove(), 900);
    }, i * 18);
  }
}

let rainBox = null;
function rainHats() {
  if (!rainBox) { rainBox = el("div", "x-rain"); document.body.appendChild(rainBox); }
  for (let i = 0; i < 18; i++) {
    setTimeout(() => {
      const h = el("div", "x-fall");
      h.textContent = Math.random() > 0.15 ? "🤠" : "🎩";
      h.style.left = Math.random() * 100 + "vw";
      h.style.fontSize = 1.5 + Math.random() * 2.5 + "rem";
      const dur = 2 + Math.random() * 2;
      h.style.animationDuration = dur + "s";
      rainBox.appendChild(h);
      setTimeout(() => h.remove(), dur * 1000 + 100);
    }, i * 80);
  }
  toast("🤠 Well howdy! You found the secret!");
}

/* Floating hat with confetti and cursor sparks */
if (flags.floatingHat) {
  const hat = el("div", "", "🤠");
  hat.id = "x-hat";
  hat.title = "Howdy";
  document.body.appendChild(hat);
  let t = Math.random() * Math.PI * 2, clicks = 0, orange = true;
  (function anim() {
    t += 0.007;
    hat.style.left = Math.max(60, Math.min(innerWidth - 80, innerWidth * 0.82 + 90 * Math.sin(t))) + "px";
    hat.style.top = Math.max(80, Math.min(innerHeight - 90, innerHeight * 0.65 + 55 * Math.sin(2 * t))) + "px";
    requestAnimationFrame(anim);
  })();
  hat.addEventListener("click", (e) => {
    e.stopPropagation();
    confetti(e.clientX, e.clientY, 22);
    const i = clicks % 5;
    if (i === 0) rainHats();
    else if (i === 1) { orange = !orange; hat.textContent = orange ? "🤠" : "🎩"; toast(orange ? "Back to orange! 🟠" : "Business casual mode 🎩"); }
    else if (i === 2) toast("One call. Every system. Zero excuses. 🤠");
    else if (i === 3) { rainHats(); confetti(e.clientX, e.clientY, 40); }
    else toast("No data caps. No ticket queues. No BS. 🤠");
    clicks++;
  });
  let lx = 0, ly = 0, lt = 0, si = 0;
  document.addEventListener("mousemove", (e) => {
    const now = Date.now(), dx = e.clientX - lx, dy = e.clientY - ly;
    if (Math.hypot(dx, dy) < 8 || now - lt < 28) return;
    lx = e.clientX; ly = e.clientY; lt = now;
    const sp = el("div");
    sp.style.cssText = `position:fixed;width:8px;height:8px;border-radius:50%;pointer-events:none;z-index:9997;left:${e.clientX}px;top:${e.clientY}px;background:${COLORS[si++ % COLORS.length]};animation:x-spark .55s ease-out forwards`;
    sp.style.setProperty("--sx", (Math.random() - 0.5) * 28 + "px");
    sp.style.setProperty("--sy", Math.random() * 16 + 4 + "px");
    document.body.appendChild(sp);
    setTimeout(() => sp.remove(), 620);
  });
}

/* Konami code: cowboy mode */
if (flags.konami) {
  const ov = el("div", "x-konami", `<button class="x" type="button" aria-label="Close">×</button><div>🤠</div><div class="t">HOWDY PARTNER!</div><div class="s">You found the cowboy code. Welcome to the HowdyNET inner circle.<br><code>↑↑↓↓←→←→BA</code>, nice work, partner.</div><div class="btns"><a class="btn btn-primary" href="/about#contact">Say howdy</a><a class="btn btn-ghost" href="/about#coverage" style="color:#FDF6EE">Check my coverage</a></div><div class="s" style="font-size:.875rem">Press Escape to exit cowboy mode</div>`);
  document.body.appendChild(ov);
  const close = () => ov.classList.remove("show");
  ov.querySelector(".x").addEventListener("click", close);
  const KS = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
  let kp = 0, kt = null;
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { close(); return; }
    if (e.key === KS[kp]) {
      kp++; clearTimeout(kt); kt = setTimeout(() => { kp = 0; }, 2000);
      if (kp === KS.length) { kp = 0; launch(); }
    } else kp = e.key === KS[0] ? 1 : 0;
  });
  function launch() {
    ov.classList.add("show");
    rainHats();
    for (let i = 0; i < 5; i++) {
      setTimeout(() => {
        const tw = el("div", "x-tumble", "🌵");
        tw.style.top = 15 + Math.random() * 65 + "vh";
        tw.style.animationDuration = 3 + Math.random() * 2.5 + "s";
        tw.style.animationDelay = i * 0.4 + "s";
        document.body.appendChild(tw);
        setTimeout(() => tw.remove(), 9000);
      }, i * 500);
    }
  }
}

/* Promo popup, once per session, after scrolling halfway */
if (flags.promoPopup && cfg.promo) {
  const KEY = "howdynet.promo";
  let shown = false;
  try { shown = sessionStorage.getItem(KEY) === "1"; } catch (e) {}
  if (!shown) {
    const p = cfg.promo;
    const img = p.image && p.image.src ? `<img src="${p.image.src}" alt="${(p.image.alt || "").replace(/"/g, "&quot;")}">` : `<img src="/img/hat-orange-320.webp" alt="">`;
    const ov = el("div", "x-popup", `<div class="box" role="dialog" aria-modal="true" aria-labelledby="x-promo-title"><button class="close" type="button" aria-label="Close">×</button><div class="left">${img}</div><div class="right"><h2 id="x-promo-title"></h2><p></p><a class="btn btn-primary"></a><button class="dismiss" type="button">No thanks</button></div></div>`);
    ov.querySelector("h2").textContent = p.title;
    ov.querySelector("p").textContent = p.body;
    const a = ov.querySelector("a");
    a.textContent = p.ctaText;
    a.href = p.ctaHref || "/about#contact";
    document.body.appendChild(ov);
    const close = () => { ov.classList.remove("show"); setTimeout(() => (ov.style.display = "none"), 350); };
    ov.querySelector(".close").addEventListener("click", close);
    ov.querySelector(".dismiss").addEventListener("click", close);
    ov.addEventListener("click", (e) => { if (e.target === ov) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    const onScroll = () => {
      const pct = scrollY / Math.max(1, document.body.scrollHeight - innerHeight);
      if (pct < 0.5) return;
      removeEventListener("scroll", onScroll);
      try { sessionStorage.setItem(KEY, "1"); } catch (e) {}
      ov.style.display = "flex";
      requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add("show")));
    };
    addEventListener("scroll", onScroll, { passive: true });
  }
}

/* Vendor Wrangler game, opened from a footer button */
if (flags.game) {
  const footer = document.querySelector(".site-footer .footer-bottom");
  const btn = el("button", "x-game-btn", "🤠 Play: Vendor Wrangler. Can you run the whole operation?");
  btn.type = "button";
  (footer ? footer.parentNode : document.body).insertBefore(btn, footer || null);
  const ov = el("div", "x-game", `<div class="intro"><b>🤠 The HowdyNET way</b>Most businesses juggle a dozen vendors. Move to catch the invoices in the hat, click to lasso the hidden costs away.</div><div class="wrap"><div class="ui"><span>Score: <b id="x-score">0</b></span><button type="button" class="x-close">× Close</button><span class="time">Time: <span id="x-time">30</span>s</span></div><canvas id="x-canvas" width="520" height="400"></canvas></div>`);
  document.body.appendChild(ov);
  let state = null, tick = null;
  const close = () => { ov.classList.remove("open"); if (state) { cancelAnimationFrame(state.raf); state = null; } clearInterval(tick); };
  ov.querySelector(".x-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  btn.addEventListener("click", () => { ov.classList.add("open"); start(); });

  function start() {
    const canvas = document.getElementById("x-canvas"), ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height, hatY = H - 65;
    const scoreEl = document.getElementById("x-score"), timeEl = document.getElementById("x-time");
    let hatX = W / 2, score = 0, timeLeft = 30, combo = 0, comboTimer = 0, maxCombo = 0, caught = 0, blasted = 0, lastSpawn = 0;
    let items = [], lassos = [], particles = [], explosions = [];
    scoreEl.textContent = "0"; timeEl.textContent = "30";
    const GOOD = [["Invoice #847", "📄", "#E86A1A", 10], ["ISP Contract", "📋", "#C85500", 15], ["IT Ticket", "🎫", "#8B2200", 10], ["AV Quote", "🖥️", "#D97706", 12], ["Cable Co.", "📡", "#92400E", 10], ["5 Vendors", "👥", "#B45309", 20], ["MSP Invoice", "💼", "#78350F", 15]];
    const BAD = [["Hidden Fee", "💸", "#DC2626", 15], ["40% Markup", "📈", "#B91C1C", 20], ["Data Cap", "🚫", "#991B1B", 15], ["Hold Music", "🎵", "#7F1D1D", 10], ["Bufferbloat", "🐌", "#BE123C", 20], ["Ticket #4821", "⏳", "#9F1239", 12], ["Rate Hike", "💀", "#881337", 25]];
    const pos = (e) => { const r = canvas.getBoundingClientRect(); const s = W / r.width; return [(e.clientX - r.left) * s, (e.clientY - r.top) * s]; };
    canvas.onmousemove = (e) => { hatX = pos(e)[0]; };
    canvas.ontouchmove = (e) => { e.preventDefault(); hatX = pos(e.touches[0])[0]; };
    canvas.onclick = (e) => { const [tx, ty] = pos(e); const dx = tx - hatX, dy = ty - hatY, d = Math.hypot(dx, dy) || 1; lassos.push({ x: hatX, y: hatY, vx: (dx / d) * 12, vy: (dy / d) * 12, trail: [], age: 0, alive: true }); };
    clearInterval(tick);
    tick = setInterval(() => { timeLeft--; timeEl.textContent = timeLeft; if (comboTimer > 0) comboTimer--; else combo = 0; if (timeLeft <= 0) { clearInterval(tick); end(); } }, 1000);
    const setScore = () => { scoreEl.textContent = score; };
    function drawHat(x, y) {
      const g = ctx.createRadialGradient(x, y - 20, 10, x, y - 20, 55);
      g.addColorStop(0, "rgba(232,106,26,0.18)"); g.addColorStop(1, "rgba(232,106,26,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(x, y - 20, 55, 14, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#E86A1A"; ctx.beginPath(); ctx.ellipse(x, y - 20, 44, 9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#8B2200"; ctx.fillRect(x - 26, y - 13, 52, 7);
      ctx.fillStyle = "#C85500"; ctx.beginPath(); ctx.moveTo(x - 25, y - 6); ctx.lineTo(x - 17, y + 22); ctx.lineTo(x + 17, y + 22); ctx.lineTo(x + 25, y - 6); ctx.closePath(); ctx.fill();
    }
    function drawItem(v) {
      const rx = v.x - v.w / 2, ry = v.y - v.h / 2;
      ctx.fillStyle = "rgba(0,0,0,0.2)"; ctx.beginPath(); ctx.roundRect(rx + 2, ry + 3, v.w, v.h, 7); ctx.fill();
      ctx.fillStyle = v.color; ctx.beginPath(); ctx.roundRect(rx, ry, v.w, v.h, 7); ctx.fill();
      if (v.bad) { ctx.strokeStyle = "rgba(255,50,50,0.6)"; ctx.lineWidth = 1.5; ctx.stroke(); }
      ctx.fillStyle = "rgba(255,255,255,0.92)"; ctx.font = "bold 11px Nunito,sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(v.emoji + " " + v.label, v.x, v.y);
    }
    function explode(x, y, color, label) {
      const parts = [];
      for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; parts.push({ x, y, vx: Math.cos(a) * (2 + Math.random() * 4), vy: Math.sin(a) * (2 + Math.random() * 4), life: 1, color, r: 3 + Math.random() * 5 }); }
      explosions.push({ x, y, label, life: 1.2, parts });
    }
    function burst(x, y, color, pts, good) {
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; particles.push({ x, y, vx: Math.cos(a) * (1.5 + Math.random() * 3), vy: Math.sin(a) * (1.5 + Math.random() * 3) - 1, life: 1, color: good ? color : "#ef4444", text: (good ? "+" : "-") + pts, isText: i === 0 }); }
    }
    function loop(ts) {
      if (!state) return;
      ctx.fillStyle = "#051830"; ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = "rgba(26,159,224,0.04)"; ctx.lineWidth = 1;
      for (let gx = 0; gx < W; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
      for (let gy = 0; gy < H; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
      if (ts - lastSpawn > Math.max(480, 1050 - (30 - timeLeft) * 15)) {
        lastSpawn = ts;
        const bad = Math.random() < 0.42, def = (bad ? BAD : GOOD)[Math.floor(Math.random() * 7)];
        items.push({ x: 35 + Math.random() * (W - 70), y: -30, speed: 1.6 + Math.random() * 2.2 + (30 - timeLeft) * 0.065, wobble: Math.random() * Math.PI * 2, w: 88, h: 30, label: def[0], emoji: def[1], color: def[2], pts: def[3], bad, alive: true });
      }
      items = items.filter((v) => {
        if (!v.alive) return false;
        v.y += v.speed; v.wobble += 0.035; v.x += Math.sin(v.wobble) * 0.5;
        const inHat = v.y + v.h / 2 >= hatY - 30 && v.y + v.h / 2 <= hatY + 5 && v.x >= hatX - 40 && v.x <= hatX + 40;
        if (inHat && !v.bad) { score += v.pts; caught++; combo++; comboTimer = 3; maxCombo = Math.max(maxCombo, combo); setScore(); burst(v.x, v.y, v.color, v.pts, true); return false; }
        if (inHat && v.bad) { score = Math.max(0, score - v.pts); combo = 0; setScore(); burst(v.x, v.y, "#ef4444", v.pts, false); explode(v.x, v.y, "#ef4444", "-" + v.pts + " ouch!"); return false; }
        if (v.y > H + 40) return false;
        drawItem(v); return true;
      });
      lassos = lassos.filter((l) => {
        l.age++; l.x += l.vx; l.y += l.vy; l.trail.push({ x: l.x, y: l.y }); if (l.trail.length > 12) l.trail.shift();
        for (let i = 1; i < l.trail.length; i++) { const a = i / l.trail.length; ctx.strokeStyle = `rgba(232,106,26,${a * 0.9})`; ctx.lineWidth = 2.5 * a; ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(l.trail[i - 1].x, l.trail[i - 1].y); ctx.lineTo(l.trail[i].x, l.trail[i].y); ctx.stroke(); }
        ctx.fillStyle = "#facc15"; ctx.beginPath(); ctx.arc(l.x, l.y, 4, 0, Math.PI * 2); ctx.fill();
        items.forEach((v) => {
          if (!v.alive || !l.alive) return;
          const d = Math.hypot(l.x - v.x, l.y - v.y);
          if (v.bad && d < 36) { score += v.pts; blasted++; combo++; comboTimer = 3; maxCombo = Math.max(maxCombo, combo); setScore(); explode(v.x, v.y, v.color, "💥 +" + v.pts); v.alive = false; l.alive = false; }
          else if (!v.bad && d < 30) { score = Math.max(0, score - v.pts); combo = 0; setScore(); explode(v.x, v.y, "#6EC6F0", "⚠️ -" + v.pts); v.alive = false; l.alive = false; }
        });
        if (l.x < -20 || l.x > W + 20 || l.y < -20 || l.y > H + 20 || l.age > 80) l.alive = false;
        return l.alive;
      });
      explosions = explosions.filter((ex) => {
        ex.life -= 0.035; if (ex.life <= 0) return false;
        ex.parts.forEach((p) => { p.x += p.vx; p.y += p.vy; p.vy += 0.12; p.life -= 0.04; if (p.life > 0) { ctx.globalAlpha = p.life; ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; } });
        ctx.globalAlpha = Math.min(1, ex.life); ctx.font = "bold 13px Nunito,sans-serif"; ctx.fillStyle = "#facc15"; ctx.textAlign = "center"; ctx.fillText(ex.label, ex.x, ex.y - (1.2 - ex.life) * 40); ctx.globalAlpha = 1;
        return true;
      });
      particles = particles.filter((p) => {
        p.x += p.vx; p.y += p.vy; p.vy += 0.1; p.life -= 0.04; if (p.life <= 0) return false;
        ctx.globalAlpha = p.life;
        if (p.isText) { ctx.font = `bold ${combo >= 3 ? 15 : 13}px Nunito,sans-serif`; ctx.fillStyle = combo >= 3 ? "#facc15" : p.color; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(p.text, p.x, p.y); }
        else { ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
        ctx.globalAlpha = 1; return true;
      });
      drawHat(hatX, hatY);
      ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(0, H - 22, W, 22);
      ctx.font = "11px Nunito,sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.45)"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText("🤠 Move to CATCH invoices · Click to LASSO costs away", 8, H - 11);
      ctx.textAlign = "right"; ctx.fillStyle = "rgba(26,159,224,0.8)"; ctx.fillText("🎯 Caught: " + caught + "   💥 Blasted: " + blasted, W - 8, H - 11);
      if (combo >= 2 && comboTimer > 0) { ctx.globalAlpha = Math.min(1, comboTimer * 0.5); ctx.font = `bold ${14 + combo * 2}px Nunito,sans-serif`; ctx.fillStyle = "#facc15"; ctx.textAlign = "center"; ctx.fillText("COMBO x" + combo + "!", W / 2, 38); ctx.globalAlpha = 1; }
      state.raf = requestAnimationFrame(loop);
    }
    function end() {
      if (state) cancelAnimationFrame(state.raf);
      state = null;
      ctx.fillStyle = "rgba(5,24,48,0.94)"; ctx.fillRect(0, 0, W, H); ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "bold 22px Nunito,sans-serif"; ctx.fillStyle = "#F5956A"; ctx.fillText("🤠 Round over!", W / 2, H / 2 - 100);
      ctx.font = "bold 58px Nunito,sans-serif"; ctx.fillStyle = "#E86A1A"; ctx.fillText(score, W / 2, H / 2 - 44);
      ctx.font = "13px Nunito,sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.fillText("Vendors consolidated: " + caught + "   Costs blasted: " + blasted, W / 2, H / 2 + 16);
      if (maxCombo >= 3) { ctx.font = "bold 12px Nunito,sans-serif"; ctx.fillStyle = "#facc15"; ctx.fillText("Best combo: x" + maxCombo + " 🔥", W / 2, H / 2 + 40); }
      const msg = blasted > caught * 1.5 ? "Cost eliminator. 🤠 Finance teams love you." : caught > blasted * 1.5 ? "Natural consolidator. You were born for this." : score >= 300 ? "You ran the whole operation. Call us. 🤠" : score >= 150 ? "Solid work. HowdyNET handles the rest." : "That's exactly why you need us. 😄";
      ctx.font = "bold 13px Nunito,sans-serif"; ctx.fillStyle = "#6EC6F0"; ctx.fillText(msg, W / 2, H / 2 + 68);
      ctx.font = "11px Nunito,sans-serif"; ctx.fillStyle = "rgba(255,255,255,0.35)"; ctx.fillText("One hat. All the cattle. Zero chaos. Call HowdyNET.", W / 2, H / 2 + 96);
    }
    if (state) cancelAnimationFrame(state.raf);
    state = { raf: requestAnimationFrame(loop) };
  }
}
