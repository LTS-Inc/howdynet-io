#!/usr/bin/env python3
"""One-off splitter used to port the hand-written index.html into site/src.

Run once against the original upload; the generated files are then hand-edited
and committed. Kept for auditability of what was mechanical vs. manual.

    python3 scripts/migrate-site.py <index.html> <privacy.html> <terms.html>
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "site" / "src"
index_path, privacy_path, terms_path = (Path(p) for p in sys.argv[1:4])
lines = index_path.read_text(encoding="utf-8").split("\n")

# ---------------------------------------------------------------- images
HATS = {}  # md5 prefix -> (filename, var)
B64 = re.compile(r'<img([^>]*?)src="data:image/png;base64,([A-Za-z0-9+/=]+)"([^>]*?)/?>')
KNOWN = {"178e269c": ("hat-orange.png", "hatOrange"), "8221f962": ("hat-blue.png", "hatBlue")}


def img_repl(m):
    import base64
    before, blob, after = m.group(1), m.group(2), m.group(3)
    key = hashlib.md5(f"data:image/png;base64,{blob}".encode()).hexdigest()[:8]
    fname, var = KNOWN[key]
    out = ROOT / "assets" / fname
    if not out.exists():
        out.write_bytes(base64.b64decode(blob))
    HATS[var] = fname
    attrs = (before + " " + after).strip()
    attrs = re.sub(r"\s+", " ", attrs)
    if "alt=" not in attrs:
        attrs += ' alt="HowdyNET"'
    return f"<Image src={{{var}}} width={{512}} {attrs} />"


# ---------------------------------------------------------------- text edits
def edit(html: str) -> str:
    html = html.replace('href="privacy.html"', 'href="/privacy"').replace('href="terms.html"', 'href="/terms"')
    html = html.replace('href="coverage.html"', 'href="/coverage"')
    html = html.replace("privacy@howdynet.io", "support@howdynet.io")
    html = html.replace(' data-netlify="true"', "")
    html = html.replace('name="contact" method="POST"', 'name="contact" method="POST" action="/api/form"')
    html = html.replace('name="custom-quote" method="POST"', 'name="custom-quote" method="POST" action="/api/form"')
    html = html.replace('name="network-results" method="POST"', 'name="network-results" method="POST" action="/api/form"')
    # Turnstile widget + honeypot directly above each submit button
    for btn in ('<button type="submit" class="btn-submit">', '<button type="submit" class="quote-submit">', '<button type="submit" class="b-send-btn">'):
        html = html.replace(btn, "<Turnstile />\n" + btn)
    return html


def chunk(a: int, b: int, drop=()):
    """1-indexed inclusive line range, minus any (a,b) ranges to drop."""
    out = []
    for n in range(a, b + 1):
        if any(x <= n <= y for x, y in drop):
            continue
        out.append(lines[n - 1])
    return "\n".join(out).strip("\n") + "\n"


def component(name: str, body: str, *, wrap_script=False):
    body = edit(body)
    body = B64.sub(img_repl, body)
    imports = []
    if "<Image " in body:
        imports.append('import { Image } from "astro:assets";')
        for var, fname in HATS.items():
            if f"{{{var}}}" in body:
                imports.append(f'import {var} from "../assets/{fname}";')
    if "<Turnstile />" in body:
        imports.append('import Turnstile from "./Turnstile.astro";')
    fm = "---\n" + "\n".join(imports) + ("\n" if imports else "") + "---\n"
    (ROOT / "components" / f"{name}.astro").write_text(fm + body, encoding="utf-8")


# ---------------------------------------------------------------- global css
(ROOT / "styles" / "global.css").write_text(chunk(10, 1728), encoding="utf-8")

# ---------------------------------------------------------------- components (verbatim line ranges from the original)
component("Popup", chunk(1773, 1801))
component("Nav", chunk(1803, 1848))
component("Hero", chunk(1849, 1994))
component("Ethos", chunk(1995, 2012))
component("Industries", chunk(2013, 2067))
component("WhyNot", chunk(2068, 2168))
component("Wisp", chunk(2169, 2251))
component("Internet", chunk(2252, 2303))
component("Lan", chunk(2304, 2380))
component("Plans", chunk(2381, 2481))
component("Calculators", chunk(2482, 2543))
component("IspPlans", chunk(2544, 2635))
component("RanchHand", chunk(2636, 2780))
component("FreeDiagnosis", chunk(2781, 2885))
component("CustomApps", chunk(2886, 2991))
component("LedAv", chunk(2992, 3065))
component("About", chunk(3066, 3090))
component("Proof", chunk(3091, 3133))
component("Community", chunk(3134, 3153))
component("Faq", chunk(3154, 3219))
component("Contact", chunk(3220, 3306))
# The original footer contained a pasted duplicate of the #popup dialog (lines 3314-3342, duplicate id). Dropped.
component("Footer", chunk(3307, 3385, drop=[(3314, 3342)]))
component("HowdyPopup", chunk(3386, 3429))
component("QuoteModal", chunk(4449, 4497))
component("StickyBar", chunk(4813, 4824))
component("CookieBanner", chunk(4908, 4917))

# ---------------------------------------------------------------- scripts, in original document order, inline (they define globals used by on* attributes)
script_ranges = [(3430, 4447), (4498, 4534), (4536, 4565), (4570, 4811), (4825, 4845), (4846, 4906), (4919, 4932)]
parts = []
for a, b in script_ranges:
    body = chunk(a, b)
    body = re.sub(r"^<script>", "<script is:inline>", body)
    parts.append(body)
(ROOT / "components" / "SiteScripts.astro").write_text("---\n---\n" + "\n".join(parts), encoding="utf-8")

# ---------------------------------------------------------------- legal pages: wrapper content only (layout is shared)
for src, name in ((privacy_path, "privacy"), (terms_path, "terms")):
    html = src.read_text(encoding="utf-8")
    start = html.index('<div class="wrapper">') + len('<div class="wrapper">')
    end = html.index("<footer>")
    inner = html[start:end].rstrip()
    assert inner.endswith("</div>"), name
    inner = inner[: -len("</div>")].rstrip("\n")
    (ROOT / "pages" / f"{name}.body.html").write_text(inner + "\n", encoding="utf-8")

print("hats:", HATS)
