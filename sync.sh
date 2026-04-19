#!/usr/bin/env bash
set -euo pipefail

PAPER_DB="$HOME/.cursor/paper-db"
SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
PAPERS_DIR="$SITE_DIR/papers"

mkdir -p "$PAPERS_DIR"

# Pre-flight: LaTeX validation. Stray $ for currency, CJK in math etc.
# would render as red garbage on the published pages, so block the sync.
if [ -f "$PAPER_DB/tools/check_latex.py" ]; then
  echo "Running LaTeX pre-flight check on all notes..."
  if ! python3 "$PAPER_DB/tools/check_latex.py" --all --summary; then
    echo
    echo "❌ LaTeX errors found. Run with details:"
    echo "   python3 $PAPER_DB/tools/check_latex.py --all --quiet"
    echo "   python3 $PAPER_DB/tools/check_latex.py --all --fix    # auto-escape currency"
    exit 1
  fi
fi

# Pre-flight: image-duplicate check. Sub-agents that download Tier-1 (xN.png)
# AND rename them to semantic names (figN-...) leave both copies behind.
if [ -f "$PAPER_DB/tools/dedupe_images.py" ]; then
  echo "Checking for duplicate PNGs..."
  if ! python3 "$PAPER_DB/tools/dedupe_images.py" --check >/dev/null 2>&1; then
    echo
    echo "❌ Duplicate images detected. Run:"
    echo "   python3 $PAPER_DB/tools/dedupe_images.py --dry-run   # preview"
    echo "   python3 $PAPER_DB/tools/dedupe_images.py             # auto-clean safe dups"
    python3 "$PAPER_DB/tools/dedupe_images.py" --check
    exit 1
  fi
fi

python3 - "$PAPER_DB" "$SITE_DIR" << 'PYEOF'
import json, os, sys, re, html, base64, mimetypes, shutil, hashlib
from pathlib import Path

DB_DIR = sys.argv[1]
SITE_DIR = sys.argv[2]
PAPERS_DIR = os.path.join(SITE_DIR, "papers")

with open(os.path.join(DB_DIR, "papers.json")) as f:
    db = json.load(f)

papers = sorted(db["papers"], key=lambda p: p.get("date", ""), reverse=True)

CAT_COLORS = {
    "algorithm": "#16a34a", "kernel": "#ea580c", "framework": "#2563eb",
    "llm": "#9333ea", "agent": "#dc2626", "cluster": "#0891b2",
    "hardware": "#b45309", "code": "#64748b"
}
CAT_LABELS = {
    "algorithm": "Algorithm", "kernel": "Kernel", "framework": "Framework",
    "llm": "LLM", "agent": "Agent", "cluster": "Cluster",
    "hardware": "Hardware", "code": "Code"
}

IMG_DIR = os.path.join(DB_DIR, "images")

def img_to_base64(paper_id, filename):
    """Convert a local image to base64 data URI."""
    filepath = os.path.join(IMG_DIR, paper_id, filename)
    if not os.path.isfile(filepath):
        return None
    fsize = os.path.getsize(filepath)
    if fsize > 2 * 1024 * 1024:
        return None
    mime, _ = mimetypes.guess_type(filepath)
    if not mime:
        mime = "image/png"
    with open(filepath, "rb") as f:
        data = base64.b64encode(f.read()).decode()
    return f"data:{mime};base64,{data}"

def resolve_img_src(paper_id, src):
    """Resolve an image markdown src to a base64 data URI."""
    if src.startswith("data:"):
        return src
    fname = src.split("/")[-1]
    patterns = [
        os.path.join(IMG_DIR, paper_id, fname),
        os.path.join(IMG_DIR, paper_id, src.replace("../images/" + paper_id + "/", "")),
    ]
    for p in patterns:
        if os.path.isfile(p):
            return img_to_base64(paper_id, os.path.basename(p))
    if os.path.isdir(os.path.join(IMG_DIR, paper_id)):
        for f in os.listdir(os.path.join(IMG_DIR, paper_id)):
            if fname.lower() in f.lower() or f.lower() in fname.lower():
                return img_to_base64(paper_id, f)
    return None

def sanitize_html(text):
    """Remove any local filesystem paths from output."""
    text = re.sub(r'/home/[^\s<>"\']+', '[path]', text)
    text = re.sub(r'~/.cursor/[^\s<>"\']+', '[path]', text)
    text = re.sub(r'/apps/[^\s<>"\']+', '[path]', text)
    return text

SHARED_CSS = """
:root {
  --bg: #faf8f3; --sf: #fff; --tx: #1a1a2e; --mt: #6b7280;
  --bd: #e5e7eb; --accent: #2563eb; --nav: #1b2a4a;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'IBM Plex Sans', 'Noto Sans SC', system-ui, sans-serif;
  background: var(--bg); color: var(--tx); line-height: 1.8;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
nav {
  background: var(--nav); color: #fff; padding: 0 24px;
  height: 52px; display: flex; align-items: center; gap: 28px;
  position: sticky; top: 0; z-index: 100;
  box-shadow: 0 2px 12px rgba(0,0,0,0.15);
}
nav .logo { font-weight: 700; font-size: 1.05rem; }
nav a { color: #cbd5e1; font-size: 0.88rem; font-weight: 500; }
nav a:hover { color: #fff; text-decoration: none; }
.w { max-width: 960px; margin: 0 auto; padding: 0 24px 64px; }
footer {
  text-align: center; padding: 28px 24px; color: var(--mt);
  font-size: 0.8rem; border-top: 1px solid var(--bd);
  max-width: 960px; margin: 0 auto;
}
.cat-tag {
  font-size: 0.7rem; font-weight: 700; padding: 2px 10px;
  border-radius: 999px; color: #fff; display: inline-block;
}

/* =========  Responsive breakpoints  =========
   ≤480px  — phone portrait (iPhone 12-15 mini, SE)
   ≤768px  — phone landscape / iPad Mini 7 portrait
   ≤1024px — iPad Mini 7 landscape / iPad Pro 12.9 portrait
   >1024px — desktop / iPad Pro 12.9 landscape
   ============================================== */

/* Tablet & below: shrink content padding, lighter spacing */
@media (max-width: 1024px) {
  .w { padding: 0 18px 48px; }
  footer { padding: 24px 18px; }
}

/* iPad Mini portrait & smaller: nav becomes scrollable, hero compacted */
@media (max-width: 768px) {
  nav {
    padding: 0 16px; gap: 18px; height: 48px;
    overflow-x: auto; overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }
  nav::-webkit-scrollbar { display: none; }
  nav .logo { font-size: 0.98rem; flex-shrink: 0; }
  nav a { font-size: 0.82rem; flex-shrink: 0; white-space: nowrap; }
  .w { padding: 0 14px 40px; }
}

/* Phone portrait: stack everything */
@media (max-width: 480px) {
  nav { gap: 14px; padding: 0 12px; height: 44px; }
  nav .logo { font-size: 0.92rem; }
  nav a { font-size: 0.78rem; }
  .w { padding: 0 12px 32px; }
  .cat-tag { font-size: 0.65rem; padding: 2px 8px; }
}
"""

NAV_HTML = """<nav>
  <a class="logo" href="/">Feiyue Zhai</a>
  <a href="/">Papers</a>
  <a href="/knowledge-graph.html">Graph</a>
  <a href="/float.html">Tools</a>
  <a href="https://github.com/ZhaiFeiyue" target="_blank">GitHub</a>
</nav>"""

FONTS = '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=Noto+Sans+SC:wght@400;600;700&family=Noto+Serif+SC:wght@400;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">'

KATEX_CDN = """<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js"
  onload="renderMathInElement(document.body, {
    delimiters: [
      {left: '$$', right: '$$', display: true},
      {left: '\\\\[', right: '\\\\]', display: true},
      {left: '$', right: '$', display: false},
      {left: '\\\\(', right: '\\\\)', display: false}
    ],
    throwOnError: false
  });"></script>"""

# ============================================================
# INDEX PAGE
# ============================================================
cat_counts = {}
for p in papers:
    cat_counts[p["category"]] = cat_counts.get(p["category"], 0) + 1

paper_rows = ""
for p in papers:
    color = CAT_COLORS.get(p["category"], "#6b7280")
    cat = CAT_LABELS.get(p["category"], p["category"])
    pid = p["id"]
    title = html.escape(p["title"])
    contrib = html.escape(p.get("core_contribution", "")[:120])
    date = p.get("date", "")
    depth = p.get("read_depth", "overview")
    depth_badge = '<span style="color:#16a34a;font-weight:600;font-size:0.75rem">Details</span>' if depth == "deep" else '<span style="color:#d97706;font-weight:600;font-size:0.75rem">Summary</span>'
    paper_rows += f"""<a class="paper-row" href="papers/{pid}.html" data-cat="{p['category']}">
  <div class="pr-meta">
    <span class="cat-tag" style="background:{color}">{cat}</span>
    <span class="pr-date">{date}</span>
    {depth_badge}
  </div>
  <div class="pr-title">{title}</div>
  <div class="pr-desc">{contrib}</div>
</a>\n"""

total = len(papers)
index_html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI Infra Paper Readings</title>
{FONTS}
<style>
{SHARED_CSS}
.hero {{
  max-width: 960px; margin: 0 auto; padding: 56px 24px 36px;
  text-align: center;
}}
.hero h1 {{
  font-size: 2rem; font-weight: 800; letter-spacing: -0.03em;
  margin-bottom: 8px;
}}
.hero p {{ color: var(--mt); font-size: 1rem; }}
.chart {{
  display: flex; align-items: flex-end; justify-content: center;
  gap: 16px; margin: 32px auto 8px; max-width: 500px; height: 120px;
}}
.bar-group {{
  display: flex; flex-direction: column; align-items: center; flex: 1;
}}
.bar {{
  width: 100%; min-width: 40px; border-radius: 6px 6px 0 0;
  transition: height .3s;
}}
.bar-count {{
  font-size: 1.1rem; font-weight: 800; margin-bottom: 4px;
}}
.bar-label {{
  font-size: 0.72rem; font-weight: 600; color: var(--mt); margin-top: 6px;
  text-align: center;
}}
.total-badge {{
  text-align: center; margin: 16px 0 4px;
  font-size: 0.9rem; color: var(--mt);
}}
.total-badge b {{ font-size: 1.6rem; font-weight: 800; color: var(--tx); }}
.paper-row {{
  display: block; background: var(--sf); border-radius: 12px;
  padding: 20px 24px; margin-bottom: 12px;
  border: 1px solid var(--bd); transition: transform .12s, box-shadow .12s;
  color: var(--tx); text-decoration: none;
}}
.paper-row:hover {{
  transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.07);
  text-decoration: none;
}}
.pr-meta {{
  display: flex; align-items: center; gap: 10px; margin-bottom: 6px;
}}
.pr-date {{
  font-size: 0.78rem; color: var(--mt);
  font-family: 'JetBrains Mono', monospace;
}}
.pr-title {{
  font-size: 1.05rem; font-weight: 700; margin-bottom: 4px;
}}
.pr-desc {{
  font-size: 0.85rem; color: var(--mt); line-height: 1.5;
}}
.filters {{
  display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px;
}}
.filter-btn {{
  font-size: 0.82rem; font-weight: 600; padding: 6px 16px;
  border-radius: 999px; border: 2px solid var(--bd);
  background: var(--sf); color: var(--mt); cursor: pointer;
  transition: all .15s;
}}
.filter-btn:hover {{
  border-color: var(--accent); color: var(--accent);
}}
.filter-btn.active {{
  background: var(--accent); color: #fff; border-color: var(--accent);
}}
.paper-row.hidden {{ display: none; }}

/* ---- Index responsive ---- */
@media (max-width: 768px) {{
  .hero {{ padding: 36px 16px 24px; }}
  .hero h1 {{ font-size: 1.5rem; }}
  .hero p {{ font-size: 0.92rem; }}
  .chart {{ gap: 8px; max-width: 100%; height: 90px; margin: 24px auto 8px; }}
  .bar {{ min-width: 24px; }}
  .bar-count {{ font-size: 0.95rem; }}
  .bar-label {{ font-size: 0.65rem; }}
  .total-badge b {{ font-size: 1.4rem; }}
  .filters {{ gap: 6px; margin-bottom: 16px; overflow-x: auto;
              flex-wrap: nowrap; -webkit-overflow-scrolling: touch;
              scrollbar-width: none; padding-bottom: 4px; }}
  .filters::-webkit-scrollbar {{ display: none; }}
  .filter-btn {{ font-size: 0.78rem; padding: 5px 12px; flex-shrink: 0; }}
  .paper-row {{ padding: 14px 16px; border-radius: 10px; margin-bottom: 10px; }}
  .pr-meta {{ gap: 8px; flex-wrap: wrap; }}
  .pr-title {{ font-size: 0.98rem; }}
  .pr-desc {{ font-size: 0.8rem; }}
}}
@media (max-width: 480px) {{
  .hero {{ padding: 24px 12px 18px; }}
  .hero h1 {{ font-size: 1.3rem; }}
  .hero p {{ font-size: 0.85rem; }}
  .chart {{ height: 70px; gap: 6px; }}
  .bar {{ min-width: 18px; }}
  .bar-label {{ font-size: 0.6rem; }}
  .paper-row {{ padding: 12px 14px; }}
  .pr-title {{ font-size: 0.92rem; line-height: 1.35; }}
  .pr-desc {{ font-size: 0.76rem; -webkit-line-clamp: 2; display: -webkit-box;
              -webkit-box-orient: vertical; overflow: hidden; }}
}}
</style>
</head>
<body>
{NAV_HTML}
<div class="hero">
  <h1>AI Infra Paper Readings</h1>
  <p>AI Infrastructure Paper Notes</p>
  <div class="total-badge"><b>{total}</b> papers</div>
  <div class="chart">
    {"".join(f'<div class="bar-group"><span class="bar-count" style="color:{CAT_COLORS.get(c,"#6b7280")}">{n}</span><div class="bar" style="background:{CAT_COLORS.get(c,"#6b7280")};height:{max(8, int(n / max(cat_counts.values()) * 80))}px"></div><div class="bar-label">{CAT_LABELS.get(c,c)}</div></div>' for c, n in sorted(cat_counts.items(), key=lambda x:-x[1]))}
  </div>
</div>
<div class="w">
<div class="filters">
  <button class="filter-btn active" data-filter="all">All ({total})</button>
  {"".join(f'<button class="filter-btn" data-filter="{c}" style="--fc:{CAT_COLORS.get(c,"#6b7280")}">{CAT_LABELS.get(c,c)} ({n})</button>' for c, n in sorted(cat_counts.items(), key=lambda x:-x[1]))}
</div>
<div id="paper-list">
{paper_rows if paper_rows else '<div style="text-align:center;padding:40px;color:var(--mt)">No papers yet.</div>'}
</div>
</div>
<footer>Built with Claude Opus 4.6</footer>
<script>
document.querySelectorAll('.filter-btn').forEach(btn => {{
  btn.addEventListener('click', () => {{
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const f = btn.dataset.filter;
    document.querySelectorAll('.paper-row').forEach(row => {{
      row.classList.toggle('hidden', f !== 'all' && row.dataset.cat !== f);
    }});
  }});
}});
</script>
</body>
</html>"""

with open(os.path.join(SITE_DIR, "index.html"), "w") as f:
    f.write(index_html)
print(f"Wrote index.html ({total} papers)")

# ============================================================
# PER-PAPER PAGES
# ============================================================
MERMAID_BOOTSTRAP_JS = """<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({
  startOnLoad: true,
  theme: 'base',
  themeVariables: {
    fontFamily: "'IBM Plex Sans', 'Noto Sans SC', sans-serif",
    fontSize: '14px',
    primaryColor: '#eff6ff',
    primaryTextColor: '#1e293b',
    primaryBorderColor: '#2563eb',
    lineColor: '#475569',
    secondaryColor: '#fef3c7',
    tertiaryColor: '#f0fdf4',
    background: '#ffffff'
  },
  flowchart: { htmlLabels: true, curve: 'basis' },
  sequence: { actorMargin: 50, messageFontSize: 13 },
  securityLevel: 'loose'
});
mermaid.run({ querySelector: '.mermaid' });
</script>"""

DRAWIO_BOOTSTRAP_JS = """<script>
(function () {
  document.querySelectorAll('.mxgraph.mxg-lazy').forEach(function (el) {
    var src = document.getElementById(el.dataset.xmlSource);
    if (!src) return;
    var cfg = {
      highlight: '#0000ff',
      nav: true,
      // resize:false — we control container size via aspect-ratio CSS so the
      // viewer should NOT try to auto-grow the container (causes blank space
      // when its internal size estimate exceeds the diagram's actual bounds).
      resize: false,
      toolbar: 'zoom layers tags lightbox pages',
      'toolbar-position': 'top',
      // fit:1 + auto-fit → viewer scales the diagram to fit the container width
      // on init AND on layout changes, eliminating empty margins around small
      // diagrams.
      fit: 1,
      'auto-fit': 1,
      // border: minimum padding (in source-coord pixels) around the diagram
      // inside the SVG viewport. Default is 60 → leaves visible white frame.
      // 5 is tight but avoids clipping anti-aliased strokes.
      border: 5,
      // 'page-visible' false hides the drawio "page" rectangle background
      // (which would otherwise outline the canvas in light gray and look like
      // wasted space when the diagram is smaller than the page).
      'page-visible': false,
      lightbox: false,
      edit: '_blank',
      xml: src.textContent.trim(),
      page: parseInt(el.dataset.page || '0', 10)
    };
    el.setAttribute('data-mxgraph', JSON.stringify(cfg));
    el.classList.remove('mxg-lazy');
  });
})();
</script>
<script type="text/javascript" src="https://viewer.diagrams.net/js/viewer-static.min.js"></script>"""


def compact_drawio_xml(drawio_path, max_row_gap=20):
    """Read drawio XML, COLLAPSE vertical empty space > max_row_gap inside
    every page, return the modified XML as a string.

    LLM-authored drawios often place cells with naive y coordinates that
    leave huge gaps (e.g. row at y=160, next row at y=350 → 190pt blank).
    Visually this looks like "the diagram is half empty". This function
    detects such gaps in each page and shifts subsequent rows upward so
    no gap exceeds max_row_gap pixels.

    CONTAINER cells (style contains 'container=1' / 'swimlane' / 'group',
    or width > 500 AND height > 300) are EXCLUDED from gap-detection —
    they visually wrap content but their height is decorative; gaps
    inside them must be detected via the inner cells. After shifting,
    container heights are also auto-shrunk to fit their inner content.

    Edges that reference cells by source/target id automatically follow
    their cells. Edges with absolute mxPoint waypoints are also shifted.
    """
    import xml.etree.ElementTree as ET
    tree = ET.parse(drawio_path)
    root = tree.getroot()

    def _is_container(cell):
        s = (cell.get('style') or '').lower()
        return ('container=1' in s or 'swimlane' in s
                or s.startswith('group') or 'group;' in s)

    # ---- per-cell style normalisation pass ----
    # 1. Strip rounded corners (rounded=1 → rounded=0): user prefers crisp,
    #    technical-document boxes.
    # 2. Force whiteSpace=wrap;html=1 so long lines actually wrap inside
    #    cells instead of overflowing.
    # 3. Scale fontSize ×1.5 (min 13pt) for legibility…
    # 4. …but CAP each cell's fontSize so the longest line of its text
    #    does not exceed cell width. Estimate char width ≈ 0.55 × fontSize
    #    (works for mixed CJK + ASCII).
    FONT_SCALE = 1.5
    FONT_MIN = 13
    FONT_DEFAULT = 14
    CHAR_W_RATIO = 0.55   # avg width / fontSize for our CJK+ASCII mix

    def _set_or_replace(style, key, value):
        """Replace 'key=...' or append 'key=value;' if absent."""
        if re.search(rf'(?:^|;){re.escape(key)}=', style):
            return re.sub(rf'((?:^|;){re.escape(key)}=)[^;]*',
                          rf'\g<1>{value}', style)
        sep = ';' if (style and not style.endswith(';')) else ''
        return f'{style}{sep}{key}={value}'

    for c in root.iter('mxCell'):
        s = c.get('style') or ''
        value = c.get('value') or ''
        if not s and not value:
            continue

        # (1) strip rounded corners — applies to both vertices and edges
        s = _set_or_replace(s, 'rounded', '0')

        is_text_cell = bool(value)

        # (2) wrap long text inside the cell
        if is_text_cell:
            s = _set_or_replace(s, 'whiteSpace', 'wrap')
            s = _set_or_replace(s, 'html', '1')

        # (3) scale fontSize, with floor
        fm = re.search(r'fontSize=(\d+)', s)
        orig_fs = int(fm.group(1)) if fm else FONT_DEFAULT
        scaled_fs = max(int(orig_fs * FONT_SCALE), FONT_MIN)

        # (4) cap by cell width if available + text exists
        if is_text_cell:
            g = c.find('mxGeometry')
            if g is not None:
                try:
                    w = float(g.get('width', 0))
                    if w > 0:
                        # longest "logical" line length (split on \n, ignore HTML <br>)
                        plain = re.sub(r'<br\s*/?>', '\n', value)
                        plain = re.sub(r'<[^>]+>', '', plain)
                        longest = max((len(line) for line in plain.split('\n')),
                                      default=0) or 1
                        # available width minus 8pt internal padding both sides
                        max_fs_for_width = max(int((w - 16) / (longest * CHAR_W_RATIO)),
                                               FONT_MIN)
                        scaled_fs = min(scaled_fs, max_fs_for_width)
                        scaled_fs = max(scaled_fs, FONT_MIN)
                except (TypeError, ValueError):
                    pass

        s = _set_or_replace(s, 'fontSize', str(scaled_fs))
        c.set('style', s)

    for page in root.findall('.//diagram'):
        # 1. Collect inner-cell intervals; track containers separately so
        #    we can shrink them after.
        inner_intervals = []     # (y, y+h) for non-container cells
        containers = []          # (mxCell, mxGeometry, original_y, h)
        all_geoms = []           # for the shift pass
        for c in page.iter('mxCell'):
            g = c.find('mxGeometry')
            if g is None:
                continue
            try:
                y = float(g.get('y', 0))
                w = float(g.get('width', 0))
                h = float(g.get('height', 0))
            except (TypeError, ValueError):
                continue
            all_geoms.append(g)
            if w == 0 and h == 0:
                continue
            is_big_container = _is_container(c) or (w > 500 and h > 300)
            if is_big_container:
                containers.append((c, g, y, h))
            else:
                inner_intervals.append((y, y + h))

        if not inner_intervals:
            continue
        inner_intervals.sort()

        # 2. Merge overlapping intervals → "row coverage" segments
        merged = []
        for y_s, y_e in inner_intervals:
            if merged and y_s <= merged[-1][1] + 1:
                merged[-1] = (merged[-1][0], max(merged[-1][1], y_e))
            else:
                merged.append((y_s, y_e))

        # 3. Find gaps > max_row_gap
        shifts = []  # (after_y_threshold, delta)
        for i in range(1, len(merged)):
            gap = merged[i][0] - merged[i - 1][1]
            if gap > max_row_gap:
                delta = gap - max_row_gap
                shifts.append((merged[i][0], delta))
        if not shifts:
            continue

        def _shift_y(y_val):
            cumulative = 0
            for after_y, delta in shifts:
                if y_val >= after_y - 0.5:
                    cumulative += delta
            return y_val - cumulative

        # 4. Shift all mxGeometry y + mxPoint y waypoints
        for g in all_geoms:
            try:
                y = g.get('y')
                if y is not None:
                    g.set('y', str(_shift_y(float(y))))
            except (TypeError, ValueError):
                pass
        for g in page.iter('mxGeometry'):
            for pt in g.iter('mxPoint'):
                py = pt.get('y')
                if py is not None:
                    try:
                        pt.set('y', str(_shift_y(float(py))))
                    except (TypeError, ValueError):
                        pass

        # 5. Shrink container heights so they end where their inner content
        #    ends (post-shift). Each container's new height = sum of all
        #    deltas whose threshold falls inside the container's vertical
        #    extent.
        for cell, g, orig_y, orig_h in containers:
            shrink = sum(d for after_y, d in shifts
                         if orig_y < after_y <= orig_y + orig_h)
            if shrink > 0:
                try:
                    new_h = max(40.0, float(g.get('height', orig_h)) - shrink)
                    g.set('height', str(new_h))
                except (TypeError, ValueError):
                    pass

    return ET.tostring(root, encoding='unicode')


def compute_drawio_page_bounds_from_xml(xml_string, page_idx):
    """Same as compute_drawio_page_bounds but takes XML string (post-compact)."""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(xml_string)
    diagrams = root.findall('.//diagram')
    if not diagrams:
        return (1000, 600)
    page = diagrams[min(page_idx, len(diagrams) - 1)]
    min_x, min_y = float('inf'), float('inf')
    max_x, max_y = 0.0, 0.0
    for geom in page.iter('mxGeometry'):
        try:
            x = float(geom.get('x', 0))
            y = float(geom.get('y', 0))
            w = float(geom.get('width', 0))
            h = float(geom.get('height', 0))
            if w == 0 and h == 0:
                continue
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x + w)
            max_y = max(max_y, y + h)
        except (TypeError, ValueError):
            continue
    if max_x < 100 or max_y < 50 or min_x == float('inf'):
        return (1000, 600)
    return (int(max_x - min_x + 10), int(max_y - min_y + 10))


def compute_drawio_page_bounds(drawio_path, page_idx):
    """Parse drawio XML and return TIGHT (width, height) in pixels for page_idx.

    Computes the actual content bounding box (max_xy - min_xy) instead of
    naive max(x+width). LLM-authored drawios often start cells at x=40, y=10
    or even larger offsets; using just max(x+w) lets that wasted top/left
    margin become real blank space in the rendered container. The drawio
    viewer's `fit:1` + `border:5` config will re-center the content within
    the tight bounding box, eliminating both inner viewer margin AND
    outer container padding caused by stale offsets.

    Falls back to (1000, 600) on parse error.
    """
    try:
        import xml.etree.ElementTree as ET
        tree = ET.parse(drawio_path)
        root = tree.getroot()
        diagrams = root.findall('.//diagram')
        if not diagrams:
            return (1000, 600)
        page = diagrams[min(page_idx, len(diagrams) - 1)]
        min_x, min_y = float('inf'), float('inf')
        max_x, max_y = 0.0, 0.0
        for geom in page.iter('mxGeometry'):
            try:
                x = float(geom.get('x', 0))
                y = float(geom.get('y', 0))
                w = float(geom.get('width', 0))
                h = float(geom.get('height', 0))
                # ignore relative/edge geometries (they have x/y but no width)
                if w == 0 and h == 0:
                    continue
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x + w)
                max_y = max(max_y, y + h)
            except (TypeError, ValueError):
                continue
        if max_x < 100 or max_y < 50 or min_x == float('inf'):
            return (1000, 600)
        # Tight bbox: subtract leading offset so a diagram starting at (40,10)
        # doesn't inflate the container by those leftover margins.
        used_w = max_x - min_x
        used_h = max_y - min_y
        # Keep 5pt slack on each side for anti-aliased stroke clipping.
        return (int(used_w + 10), int(used_h + 10))
    except Exception:
        return (1000, 600)


def extract_drawio(md_text, state):
    """Replace `{{drawio:file#page=N}}` markers with HTML embed blocks.

    - state dict tracks which drawio files have already been inlined on the
      current paper page. First occurrence inlines the full XML inside a
      hidden text container; subsequent occurrences just reference it.
    - Each embed honours #page=N (0-indexed default page).
    - The container's aspect-ratio is computed from the actual diagram
      bounds parsed from XML — no hand-tuned height parameter needed.
      Any `#height=NNN` is honoured as a hard min-height fallback only.
    """
    blocks = []

    def _embed(m):
        raw = m.group(1).strip()
        opts = {}
        if '#' in raw:
            rel_path, rest = raw.split('#', 1)
            for pair in rest.split('&'):
                if '=' in pair:
                    k, v = pair.split('=', 1)
                    opts[k.strip()] = v.strip()
        else:
            rel_path = raw
        rel_path = rel_path.strip()
        drawio_path = os.path.join(SITE_DIR, "assets", rel_path)
        if not os.path.isfile(drawio_path):
            return f"<!-- missing drawio: {rel_path} -->"

        try:
            page_num = int(opts.get('page', 0))
        except ValueError:
            page_num = 0

        # Compact the drawio: collapse vertical gaps > 30pt inside each page.
        # This is a format transform — it doesn't touch the source file, just
        # the inlined copy used for browser rendering.
        compacted_xml = compact_drawio_xml(drawio_path, max_row_gap=30)
        # Compute bbox AFTER compaction so the container fits the tightened diagram.
        bw, bh = compute_drawio_page_bounds_from_xml(compacted_xml, page_num)
        # Aspect ratio CSS: container fills width responsively, height auto.
        # NOTE: do NOT set max-height — combining max-height with aspect-ratio
        # + width:100% causes the container to be wider than `width/ratio` on
        # short viewports, leaving vertical white space inside the SVG region.
        # If the user has a very tall diagram, browser scroll handles it.
        aspect_style = f"aspect-ratio: {bw} / {bh};"

        source_id = 'drawio-xml-' + re.sub(r'[^a-zA-Z0-9]+', '-', rel_path).strip('-')
        source_html = ''
        if rel_path not in state:
            state[rel_path] = source_id
            # Inline the COMPACTED XML so the viewer renders the tightened diagram.
            source_html = (
                f'<div id="{source_id}" class="drawio-xml-source" '
                f'style="display:none !important;" aria-hidden="true">'
                f'{html.escape(compacted_xml)}'
                f'</div>'
            )

        # Container CSS: tight margins, the inner mxgraph div uses display:block
        # to avoid baseline alignment slack underneath the SVG.
        embed_html = (
            source_html
            + '<div class="drawio-embed" style="margin:12px 0;line-height:0;">'
            f'<div class="mxgraph mxg-lazy" data-xml-source="{source_id}" '
            f'data-page="{page_num}" '
            f'style="display:block;width:100%;{aspect_style}'
            f'border:1px solid #ddd;border-radius:8px;background:#fff;'
            f'overflow:hidden;"></div>'
            '<p style="font-size:0.8rem;color:#6b7280;text-align:center;'
            'margin:6px 0 0 0;line-height:1.4;">'
            f'💡 滚轮缩放 · 拖动平移 · 顶部页签切换 · '
            f'<a href="/assets/{rel_path}" download>下载 .drawio</a>'
            '</p>'
            '</div>'
        )
        blocks.append(embed_html)
        return f"\x01DRAWIO{len(blocks)-1}\x01"

    md_text = re.sub(r'\{\{drawio:([^}]+)\}\}', _embed, md_text)
    return md_text, blocks


def restore_drawio(html_text, blocks):
    """Replace DRAWIO placeholders with raw embed HTML (strip wrapping <p>)."""
    for i, block in enumerate(blocks):
        html_text = html_text.replace(f"<p>\x01DRAWIO{i}\x01</p>", block)
        html_text = html_text.replace(f"\x01DRAWIO{i}\x01", block)
    return html_text


def protect_math(text):
    """Extract LaTeX math spans so markdown transforms don't corrupt them."""
    store = []
    def _stash(m):
        store.append(m.group(0))
        return f"\x00MATH{len(store)-1}\x00"
    text = re.sub(r'\$\$[\s\S]+?\$\$', _stash, text)
    text = re.sub(r'(?<!\$)\$(?!\$)(?!\s)(.+?)(?<!\s)\$(?!\$)', _stash, text)
    text = re.sub(r'\\\[[\s\S]+?\\\]', _stash, text)
    text = re.sub(r'\\\([\s\S]+?\\\)', _stash, text)
    return text, store

def restore_math(text, store):
    """Re-insert stashed LaTeX math spans."""
    def _restore(m):
        return store[int(m.group(1))]
    return re.sub(r'\x00MATH(\d+)\x00', _restore, text)

def inline_fmt(text):
    """Apply bold/code inline transforms while preserving LaTeX."""
    text, store = protect_math(text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    return restore_math(text, store)

def md_to_html(md_text, paper_id=""):
    """Convert markdown to HTML with base64-embedded images."""
    lines = md_text.split('\n')
    out = []
    in_table = False
    table_aligns = []          # per-column: 'left' / 'right' / 'center'
    table_pending_rows = []    # buffered until separator row decides alignments
    in_code = False
    in_mermaid = False
    in_ul = False

    def _flush_table():
        """Render the complete buffered table — including auto-detected
        column alignments — and reset state. Called at end-of-table OR
        end-of-document.
        """
        nonlocal in_table, table_aligns, table_pending_rows
        if not in_table:
            return
        rows = table_pending_rows
        if rows:
            header = rows[0]
            n = len(header)
            aligns = (table_aligns + ['left'] * n)[:n]
            # Heuristic: detect numeric columns from first 5 data rows
            for ci in range(n):
                vals = []
                for r in rows[1:6]:
                    if ci < len(r):
                        cell = re.sub(r'<[^>]+>', '', r[ci]).strip().replace(',', '')
                        vals.append(cell)
                numeric = sum(1 for v in vals if re.fullmatch(r'-?\d+(\.\d+)?%?\*?', v or 'X'))
                if vals and numeric == len(vals) and aligns[ci] == 'left':
                    aligns[ci] = 'right'
            # Render header
            ths = ''.join(f'<th style="text-align:{aligns[i]}">{header[i]}</th>'
                          for i in range(n))
            out.append(f'<thead><tr>{ths}</tr></thead><tbody>')
            for row in rows[1:]:
                cells = (row + [''] * n)[:n]
                tds = ''.join(f'<td style="text-align:{aligns[i]}">{cells[i]}</td>'
                              for i in range(n))
                out.append(f'<tr>{tds}</tr>')
            out.append('</tbody>')
        out.append('</table></div>')
        in_table = False
        table_aligns = []
        table_pending_rows = []

    for line in lines:
        stripped = line.strip()

        # Code/diagram fences: special-case mermaid
        if stripped.startswith('```'):
            lang = stripped[3:].strip().lower()
            if in_code or in_mermaid:
                if in_mermaid:
                    out.append('</div>')
                    in_mermaid = False
                else:
                    out.append('</code></pre>')
                    in_code = False
            else:
                if lang == 'mermaid':
                    out.append('<div class="mermaid">')
                    in_mermaid = True
                else:
                    out.append('<pre><code>')
                    in_code = True
            continue
        if in_mermaid:
            # Mermaid needs raw text content, no escape for &/</> needed —
            # mermaid.js parses the textContent directly.
            out.append(line)
            continue
        if in_code:
            out.append(html.escape(line))
            continue

        if in_table and not stripped.startswith('|'):
            _flush_table()

        if stripped.startswith('|') and '|' in stripped[1:]:
            cells = [c.strip() for c in stripped.split('|')[1:-1]]
            # Separator row: `:---:` / `:---` / `---:` / `---`
            if all(re.fullmatch(r':?-+:?', c) for c in cells if c):
                table_aligns = []
                for c in cells:
                    if c.startswith(':') and c.endswith(':'):
                        table_aligns.append('center')
                    elif c.endswith(':'):
                        table_aligns.append('right')
                    else:
                        table_aligns.append('left')
                continue
            rendered = [inline_fmt(c) for c in cells]
            if not in_table:
                out.append('<div class="table-wrap"><table class="md-table">')
                in_table = True
            table_pending_rows.append(rendered)
            continue

        if stripped.startswith('!['):
            m = re.match(r'!\[([^\]]*)\]\(([^)]+)\)', stripped)
            if m:
                alt, src = m.group(1), m.group(2)
                data_uri = resolve_img_src(paper_id, src) if paper_id else None
                if data_uri:
                    out.append(f'<figure><img src="{data_uri}" alt="{html.escape(alt)}" style="max-width:100%;border-radius:8px"><figcaption>{html.escape(alt)}</figcaption></figure>')
                else:
                    out.append(f'<div style="background:#f1f5f9;padding:16px;border-radius:8px;text-align:center;color:var(--mt);margin:12px 0"><i>{html.escape(alt)}</i></div>')
                continue

        if stripped.startswith('> '):
            out.append(f'<blockquote>{inline_fmt(stripped[2:])}</blockquote>')
            continue

        # Headings: support # through ###### (markdown spec).
        # Order matters — match longer prefixes first so '#### ' isn't
        # mis-classified as '### '.
        h_match = re.match(r'^(#{1,6})\s+(.+)$', stripped)
        if h_match:
            if in_ul:
                out.append('</ul>'); in_ul = False
            level = len(h_match.group(1))
            text_part = h_match.group(2)
            if level == 2:
                anchor = re.sub(r'[^a-z0-9]+', '-', text_part.lower()).strip('-')
                out.append(f'<h2 id="{anchor}">{inline_fmt(text_part)}</h2>')
            else:
                out.append(f'<h{level}>{inline_fmt(text_part)}</h{level}>')
            continue

        if stripped.startswith('- '):
            if not in_ul:
                out.append('<ul>'); in_ul = True
            out.append(f'<li>{inline_fmt(stripped[2:])}</li>')
            continue
        else:
            if in_ul:
                out.append('</ul>'); in_ul = False

        stripped = inline_fmt(stripped)

        if stripped:
            out.append(f'<p>{stripped}</p>')

    if in_ul: out.append('</ul>')
    if in_table: _flush_table()
    if in_code: out.append('</code></pre>')
    if in_mermaid: out.append('</div>')
    return '\n'.join(out)


for p in papers:
    pid = p["id"]
    title = html.escape(p["title"])
    color = CAT_COLORS.get(p["category"], "#6b7280")
    cat = CAT_LABELS.get(p["category"], p["category"])
    date = p.get("date", "")
    url = p.get("url", "")
    authors = ", ".join(p.get("authors", [])[:5])
    if len(p.get("authors", [])) > 5:
        authors += " et al."

    notes_path = os.path.join(DB_DIR, "notes", f"{pid}.md")
    if not os.path.exists(notes_path):
        continue

    with open(notes_path) as f:
        md = f.read()

    # Strip the leading `# title` + `> meta` block — it's redundant with
    # the page hero (rendered separately above).
    body_lines = md.split('\n')
    skip = 0
    for i, l in enumerate(body_lines):
        if l.startswith('# '):
            skip = i + 1
            continue
        if l.startswith('>') and i <= skip + 3:
            skip = i + 1
            continue
        break
    body_md = '\n'.join(body_lines[skip:]).strip()
    # Drop a leading `---` separator if present after the meta block
    if body_md.startswith('---'):
        body_md = body_md[3:].lstrip()

    def _dedup_cross_section_figures(summary_html, details_html):
        """Replace 2nd+ occurrence of an identical base64 image with a
        compact "↑ see above" pointer. Operates across summary AND details
        because notes frequently re-reference Key Figures inside Deep
        Analysis. Preserves the <h3>Figure N: ...</h3> heading + caption
        text so the deep-analysis prose still has its anchor."""
        seen = {}  # b64_hash -> first_figure_label_seen
        fig_pattern = re.compile(
            r'<figure><img\s+src="data:image/(?:png|jpeg|gif);base64,([A-Za-z0-9+/=]+)"\s+alt="([^"]*)"[^>]*>'
            r'(<figcaption>([^<]*)</figcaption>)?</figure>'
        )
        # First pass over summary establishes "first seen" mapping
        def repl(m):
            b64, alt, _, caption = m.group(1), m.group(2), m.group(3), m.group(4)
            h = hashlib.md5(b64.encode()).hexdigest()
            if h not in seen:
                seen[h] = alt or caption or ""
                return m.group(0)
            label = seen[h] or "image"
            return (f'<div class="fig-ref">'
                    f'<span class="fig-ref-arrow">↑</span> '
                    f'<em>{html.escape(label)}</em> '
                    f'<span class="fig-ref-note">(see above)</span>'
                    f'</div>')
        summary_html = fig_pattern.sub(repl, summary_html)
        details_html = fig_pattern.sub(repl, details_html)
        return summary_html, details_html

    def inject_images_inline(md_text, paper_id):
        """Insert base64 images inline next to their figure descriptions."""
        img_paper_dir = os.path.join(IMG_DIR, paper_id)
        if not os.path.isdir(img_paper_dir):
            return md_text

        img_files = sorted([f for f in os.listdir(img_paper_dir)
                           if f.lower().endswith(('.png','.jpg','.jpeg','.gif','.svg'))])
        if not img_files:
            return md_text

        def num_from_filename(fn):
            m = re.search(r'(\d+)', fn)
            return m.group(1) if m else None

        num_to_file = {}
        for f in img_files:
            n = num_from_filename(f)
            if n:
                if n not in num_to_file:
                    num_to_file[n] = f
                else:
                    num_to_file[n + 'b'] = f

        lines = md_text.split('\n')
        result = []
        used_images = set()

        for i, line in enumerate(lines):
            result.append(line)
            fig_match = re.match(r'^###\s+(?:Figure|Fig\.?)\s+(\d+[a-z]?)', line, re.IGNORECASE)
            if fig_match:
                fig_num = fig_match.group(1)
                matched_file = None
                if fig_num in num_to_file:
                    matched_file = num_to_file[fig_num]
                else:
                    base_num = re.match(r'(\d+)', fig_num).group(1) if re.match(r'(\d+)', fig_num) else None
                    for fn in img_files:
                        fn_num = num_from_filename(fn)
                        if fn_num == base_num and fn not in used_images:
                            matched_file = fn
                            break

                if matched_file:
                    # Look at the next NON-EMPTY line — empty lines between
                    # the heading and the image link are common markdown style
                    # and must not trigger a duplicate auto-injection.
                    has_existing_link = False
                    for la in lines[i + 1:i + 6]:
                        s = la.strip()
                        if not s:
                            continue
                        has_existing_link = s.startswith('![')
                        break
                    if not has_existing_link:
                        data = img_to_base64(paper_id, matched_file)
                        if data:
                            label = matched_file.rsplit('.', 1)[0].replace('-', ' ').replace('_', ' ')
                            result.append(f'![{label}]({matched_file})')
                    used_images.add(matched_file)

        return '\n'.join(result)

    body_md = inject_images_inline(body_md, pid)

    drawio_state = {}
    body_md, body_drawio = extract_drawio(body_md, drawio_state)

    body_html = restore_drawio(sanitize_html(md_to_html(body_md, paper_id=pid)), body_drawio)

    # Same-paper dedup: notes commonly reference the same figure in
    # `## Key Figures` AND inside `## Deep Analysis`. Render the binary
    # only ONCE; subsequent <figure><img> blocks become a slim
    # "↑ Figure N (see above)" pointer that preserves the prose anchor.
    body_html, _ = _dedup_cross_section_figures(body_html, "")

    has_drawio = bool(body_drawio)
    drawio_script = DRAWIO_BOOTSTRAP_JS if has_drawio else ""

    has_mermaid = bool(re.search(r'<div class="mermaid">', body_html))
    mermaid_script = MERMAID_BOOTSTRAP_JS if has_mermaid else ""

    # ---- TL;DR — LLM-authored content, NEVER script-derived ----
    # Architectural rule: scripts handle format; LLM owns all user-visible
    # prose. We READ from papers.json fields the LLM wrote, never compose
    # / truncate / summarise.
    #
    # Priority:
    #   1. papers.json `tldr` field (added during v2 migration; LLM-written)
    #   2. fallback: full `core_contribution` (already an LLM 1-sentence
    #      summary per skill guidance — use as-is, no truncation)
    tldr_text = (p.get('tldr') or p.get('core_contribution') or '').strip()

    tags_html = "".join(
        f'<span class="tag">{t}</span>' for t in p.get("secondary_tags", [])[:6]
    )

    page = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>{title}</title>
{FONTS}
{KATEX_CDN}
<style>
{SHARED_CSS}
.paper-header {{
  max-width: 960px; margin: 0 auto; padding: 40px 24px 24px;
}}
.paper-header h1 {{
  font-size: 1.6rem; font-weight: 800; letter-spacing: -0.02em;
  margin-bottom: 10px; line-height: 1.3;
}}
.paper-meta {{
  font-size: 0.85rem; color: var(--mt); margin-bottom: 12px;
}}
.paper-meta a {{ font-size: 0.85rem; }}
.tags {{ display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }}
.tag {{
  font-size: 0.72rem; padding: 2px 10px; border-radius: 999px;
  background: #f1f5f9; color: var(--mt); font-weight: 600;
}}
.tldr {{
  max-width: 960px; margin: 24px auto 32px; padding: 18px 24px;
  background: linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%);
  border-left: 4px solid var(--accent);
  border-radius: 6px;
  font-family: 'Noto Serif SC', 'Lora', serif;
  font-size: 0.95rem; line-height: 1.6; color: #1e293b;
}}
.tldr .tldr-label {{
  display: inline-block; font-family: 'IBM Plex Sans', sans-serif;
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em;
  color: var(--accent); margin-bottom: 6px; text-transform: uppercase;
}}
.content {{
  font-family: 'Noto Serif SC', 'Lora', serif;
  font-size: 0.95rem;
}}
.content h2 {{
  font-family: 'IBM Plex Sans', 'Noto Sans SC', sans-serif;
  font-size: 1.2rem; font-weight: 700; margin: 32px 0 12px;
  padding-bottom: 6px; border-bottom: 1px solid var(--bd);
}}
.content h3 {{
  font-family: 'IBM Plex Sans', 'Noto Sans SC', sans-serif;
  font-size: 1.05rem; font-weight: 700; margin: 24px 0 8px;
}}
.content p {{ margin: 8px 0; }}
.content ul {{ margin: 8px 0 8px 20px; }}
.content li {{ margin: 4px 0; }}
.content blockquote {{
  border-left: 4px solid var(--accent); padding: 8px 16px;
  margin: 12px 0; background: #f8fafc; border-radius: 0 8px 8px 0;
  font-style: italic;
}}
.content pre {{
  background: #1e293b; color: #e2e8f0; padding: 16px;
  border-radius: 8px; overflow-x: auto; margin: 12px 0;
  font-family: 'JetBrains Mono', monospace; font-size: 0.82rem;
  line-height: 1.6;
}}
.content code {{
  font-family: 'JetBrains Mono', monospace; font-size: 0.85em;
  background: #f1f5f9; padding: 1px 5px; border-radius: 4px;
}}
.content pre code {{
  background: none; padding: 0;
}}
.content figure {{
  margin: 16px 0; text-align: center;
}}
.content figure img {{
  max-width: 100%; border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}}
.content figcaption {{
  font-size: 0.8rem; color: var(--mt); margin-top: 6px;
  font-style: italic;
}}
.content .fig-ref {{
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px; margin: 8px 0;
  background: #f1f5f9; border-radius: 6px;
  font-size: 0.85rem; color: var(--mt);
}}
.content .fig-ref-arrow {{
  font-weight: 700; color: #2563eb;
}}
.content .fig-ref-note {{
  font-size: 0.75rem; opacity: 0.7;
}}
.table-wrap {{
  margin: 16px 0;
  overflow-x: auto;
  border-radius: 8px;
  border: 1px solid var(--bd);
  background: #fff;
}}
.md-table {{
  width: 100%; border-collapse: collapse;
  font-size: 0.85rem; min-width: 100%;
}}
.md-table th, .md-table td {{
  border-bottom: 1px solid #f1f5f9;
  padding: 8px 14px;
  white-space: nowrap;
}}
.md-table th {{
  background: #f8fafc; font-weight: 700; color: #475569;
  position: sticky; top: 0; z-index: 1;
  border-bottom: 2px solid var(--bd);
  font-family: 'IBM Plex Sans', 'Noto Sans SC', sans-serif;
  font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em;
}}
.md-table tbody tr:nth-child(even) td {{
  background: #fafbfc;
}}
.md-table tbody tr:hover td {{
  background: #eff6ff;
}}
.md-table td b, .md-table td strong {{
  color: var(--accent); font-weight: 700;
}}
.mermaid {{
  margin: 20px 0; padding: 16px;
  background: #fff; border: 1px solid var(--bd);
  border-radius: 8px; text-align: center;
  overflow-x: auto;
}}
.mermaid svg {{
  max-width: 100%; height: auto;
}}
/* drawio viewer-static SVG should fill the container instead of the
   default xMidYMid meet (which leaves blank top/bottom when container
   aspect-ratio doesn't perfectly match SVG viewBox). Forcing the inner
   SVG to width:100%/height:100% with display:block kills the bottom
   baseline whitespace. */
.drawio-embed .mxgraph svg,
.drawio-embed .mxgraph > svg {{
  display: block;
  width: 100% !important;
  height: 100% !important;
}}
.drawio-embed .mxgraph {{
  display: block;
  position: relative;
}}
.content .katex-display {{
  overflow-x: auto; overflow-y: hidden;
  padding: 4px 0; margin: 16px 0;
}}
.back {{ display: inline-block; margin: 24px; font-size: 0.9rem; font-weight: 600; }}

/* ---- Per-paper page responsive ---- */
@media (max-width: 1024px) {{
  .paper-header {{ padding: 32px 18px 20px; }}
  .tldr {{ margin: 18px 18px 24px; padding: 16px 18px; }}
  .content {{ padding: 0 18px 48px; }}
  .back {{ margin: 18px; }}
}}
@media (max-width: 768px) {{
  .paper-header {{ padding: 24px 14px 16px; }}
  .paper-header h1 {{ font-size: 1.3rem; line-height: 1.3; margin-bottom: 8px; }}
  .paper-meta {{ font-size: 0.78rem; line-height: 1.6; }}
  .paper-meta span, .paper-meta a {{ white-space: nowrap; }}
  .tldr {{ margin: 14px 14px 20px; padding: 14px 16px; font-size: 0.9rem; }}
  .tldr-label {{ font-size: 0.65rem; }}
  .content {{ padding: 0 14px 36px; font-size: 0.9rem; }}
  .content h2 {{ font-size: 1.05rem; margin: 24px 0 8px; padding-bottom: 4px; }}
  .content h3 {{ font-size: 0.98rem; margin: 18px 0 6px; }}
  .content pre {{ padding: 12px; font-size: 0.78rem; }}
  .content figure img {{ box-shadow: 0 1px 4px rgba(0,0,0,0.08); }}
  .md-table {{ font-size: 0.78rem; }}
  .md-table th, .md-table td {{ padding: 6px 10px; }}
  .md-table th {{ font-size: 0.72rem; }}
  .mermaid {{ padding: 12px 8px; margin: 16px 0; }}
  .back {{ margin: 14px; font-size: 0.84rem; }}
}}
@media (max-width: 480px) {{
  .paper-header {{ padding: 18px 12px 12px; }}
  .paper-header h1 {{ font-size: 1.15rem; }}
  .paper-meta {{ font-size: 0.74rem; }}
  .tldr {{ margin: 12px 12px 16px; padding: 12px 14px; font-size: 0.86rem; }}
  .content {{ padding: 0 12px 28px; font-size: 0.88rem; }}
  .content h2 {{ font-size: 0.98rem; }}
  .content h3 {{ font-size: 0.92rem; }}
  .content pre {{ padding: 10px; font-size: 0.74rem; }}
  .md-table {{ font-size: 0.72rem; }}
  .md-table th, .md-table td {{ padding: 5px 8px; }}
  .tag {{ font-size: 0.66rem; padding: 1px 7px; }}
  .back {{ margin: 12px; font-size: 0.8rem; }}
}}
</style>
</head>
<body>
{NAV_HTML}
<div class="paper-header">
  <a class="back" href="/">← Back</a>
  <h1>{title}</h1>
  <div class="paper-meta">
    <span class="cat-tag" style="background:{color}">{cat}</span>
    &nbsp; {authors} &nbsp;·&nbsp; {date}
    {"&nbsp;·&nbsp; <a href='" + url + "' target='_blank'>arXiv ↗</a>" if url else ""}
  </div>
  <div class="tags">{tags_html}</div>
</div>
<div class="tldr">
  <div class="tldr-label">TL;DR</div>
  <div>{html.escape(tldr_text)}</div>
</div>
<div class="w content">
{body_html}
</div>
<footer>Built with Claude Opus 4.6 · <a href="/">Back to index</a></footer>
{drawio_script}
{mermaid_script}
</body>
</html>"""

    page = sanitize_html(page)

    out_path = os.path.join(PAPERS_DIR, f"{pid}.html")
    with open(out_path, "w") as f:
        f.write(page)
    print(f"  Wrote papers/{pid}.html")

print("Sync complete.")
PYEOF

# ---------- Public JSON API ----------
# Expose papers.json under /api/ so any client (mobile app, dashboard, etc.)
# can fetch the full reading list without needing the GitHub Pages HTML.
python3 - "$PAPER_DB" "$SITE_DIR" << 'PYAPI'
import json, os, sys
from datetime import date
DB_DIR, SITE_DIR = sys.argv[1], sys.argv[2]
api_dir = os.path.join(SITE_DIR, "api")
api_papers_dir = os.path.join(api_dir, "papers")
os.makedirs(api_papers_dir, exist_ok=True)

with open(os.path.join(DB_DIR, "papers.json")) as f:
    db = json.load(f)
papers = sorted(db["papers"], key=lambda p: p.get("date", ""), reverse=True)

# /api/papers.json — full list (curated, no internal-only fields)
PUBLIC_FIELDS = ["id", "title", "authors", "date", "source", "url",
                 "category", "secondary_tags", "core_contribution",
                 "summary", "key_findings", "limitations",
                 "infra_impact", "related_paper_ids", "open_questions",
                 "read_depth", "date_read"]
public_papers = [{k: p.get(k) for k in PUBLIC_FIELDS} for p in papers]
with open(os.path.join(api_dir, "papers.json"), "w") as f:
    json.dump({
        "version": 1,
        "generated_at": date.today().isoformat(),
        "total": len(public_papers),
        "papers": public_papers,
    }, f, ensure_ascii=False, indent=2)

# /api/papers/{id}.json — per-paper detail (same fields)
for p in public_papers:
    pp = os.path.join(api_papers_dir, f"{p['id']}.json")
    with open(pp, "w") as f:
        json.dump(p, f, ensure_ascii=False, indent=2)

# /api/categories.json — per-category index (id list per cat + count)
cat_index = {}
for p in public_papers:
    c = p.get("category", "code")
    cat_index.setdefault(c, {"count": 0, "ids": []})
    cat_index[c]["count"] += 1
    cat_index[c]["ids"].append(p["id"])
with open(os.path.join(api_dir, "categories.json"), "w") as f:
    json.dump({
        "version": 1,
        "generated_at": date.today().isoformat(),
        "categories": cat_index,
    }, f, ensure_ascii=False, indent=2)

print(f"Wrote api/papers.json + api/categories.json + "
      f"{len(public_papers)} api/papers/{{id}}.json")
PYAPI

# Regenerate the interactive knowledge graph (reads ~/.cursor/paper-db/papers.json)
python3 "$SITE_DIR/tools/build_knowledge_graph.py"

# Post-sync auto-dedup: scrub duplicate base64 image embeds from any
# rendered HTML (paper pages and LLM-written reader HTMLs alike).
python3 "$SITE_DIR/tools/dedupe_html_images.py" --all >/dev/null

# Post-sync sanity: no published HTML may embed the same PNG twice.
if ! python3 "$SITE_DIR/tools/check_published_dupes.py" "$SITE_DIR"; then
  echo
  echo "❌ Published-page image deduplication check failed."
  exit 1
fi

echo "Done."
