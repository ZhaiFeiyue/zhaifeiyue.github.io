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
      // fit:1 → viewer scales the diagram to fit the container width on init,
      // eliminating large empty margins around small diagrams.
      fit: 1,
      'auto-fit': 1,
      // When users zoom out beyond fit, allow scroll within container.
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


def compute_drawio_page_bounds(drawio_path, page_idx):
    """Parse drawio XML and return (width, height) in pixels for page_idx.

    Walks every <mxCell><mxGeometry x= y= width= height=> within the requested
    <diagram> page, computes max(x+width) and max(y+height) across cells.
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
        # diagram may contain raw mxGraphModel OR base64-compressed text.
        # Sub-agent-authored files are always raw; vendor exports may be compressed.
        max_x, max_y = 0, 0
        for geom in page.iter('mxGeometry'):
            try:
                x = float(geom.get('x', 0))
                y = float(geom.get('y', 0))
                w = float(geom.get('width', 0))
                h = float(geom.get('height', 0))
                # ignore relative/edge geometries (they have x/y but no width)
                if w == 0 and h == 0:
                    continue
                max_x = max(max_x, x + w)
                max_y = max(max_y, y + h)
            except (TypeError, ValueError):
                continue
        # Add 30pt margin on right & bottom to avoid clipping
        if max_x < 100 or max_y < 50:
            return (1000, 600)
        return (int(max_x + 30), int(max_y + 30))
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

        # Compute REAL bounding box from XML — eliminates the blank-space bug
        bw, bh = compute_drawio_page_bounds(drawio_path, page_num)
        # Aspect ratio CSS: container fills width responsively, height auto.
        # Cap height at 80vh so very tall diagrams stay scrollable not page-eating.
        aspect_style = (
            f"aspect-ratio: {bw} / {bh}; "
            f"max-height: 80vh;"
        )

        source_id = 'drawio-xml-' + re.sub(r'[^a-zA-Z0-9]+', '-', rel_path).strip('-')
        source_html = ''
        if rel_path not in state:
            state[rel_path] = source_id
            with open(drawio_path, encoding='utf-8') as fh:
                xml = fh.read()
            source_html = (
                f'<div id="{source_id}" class="drawio-xml-source" '
                f'style="display:none !important;" aria-hidden="true">'
                f'{html.escape(xml)}'
                f'</div>'
            )

        embed_html = (
            source_html
            + '<div class="drawio-embed" style="margin:20px 0;">'
            f'<div class="mxgraph mxg-lazy" data-xml-source="{source_id}" '
            f'data-page="{page_num}" '
            f'style="width:100%;{aspect_style}'
            f'border:1px solid #ddd;border-radius:8px;background:#fff;"></div>'
            '<p style="font-size:0.8rem;color:#6b7280;text-align:center;margin-top:8px;">'
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
    in_code = False
    in_ul = False

    for line in lines:
        stripped = line.strip()

        if stripped.startswith('```'):
            if in_code:
                out.append('</code></pre>')
                in_code = False
            else:
                out.append('<pre><code>')
                in_code = True
            continue
        if in_code:
            out.append(html.escape(line))
            continue

        if in_table and not stripped.startswith('|'):
            out.append('</table>')
            in_table = False

        if stripped.startswith('|') and '|' in stripped[1:]:
            cells = [c.strip() for c in stripped.split('|')[1:-1]]
            if all(set(c) <= set('- :') for c in cells):
                continue
            if not in_table:
                out.append('<table class="md-table"><tr>' + ''.join(f'<th>{inline_fmt(c)}</th>' for c in cells) + '</tr>')
                in_table = True
            else:
                out.append('<tr>' + ''.join(f'<td>{inline_fmt(c)}</td>' for c in cells) + '</tr>')
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

        if stripped.startswith('### '):
            if in_ul:
                out.append('</ul>'); in_ul = False
            out.append(f'<h3>{inline_fmt(stripped[4:])}</h3>')
            continue
        if stripped.startswith('## '):
            if in_ul:
                out.append('</ul>'); in_ul = False
            anchor = re.sub(r'[^a-z0-9]+', '-', stripped[3:].lower()).strip('-')
            out.append(f'<h2 id="{anchor}">{inline_fmt(stripped[3:])}</h2>')
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
    if in_table: out.append('</table>')
    if in_code: out.append('</code></pre>')
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

    # ---- TL;DR computation (≤300 chars, plain text, no markdown) ----
    def _build_tldr(paper_entry, body_markdown):
        """Compose a plain-text TL;DR ≤300 chars.

        Priority sources:
        1. papers.json `core_contribution` (curated 1-sentence summary).
        2. First substantial paragraph of papers.json `summary`.
        3. First substantial paragraph after the leading meta block in notes.
        Truncates at sentence boundary when possible.
        """
        def _strip_md(s):
            s = re.sub(r'\$[^$\n]+\$', lambda m: m.group(0).strip('$'), s)
            s = re.sub(r'\\\$', '$', s)
            s = re.sub(r'\*\*(.+?)\*\*', r'\1', s)
            s = re.sub(r'\*(.+?)\*', r'\1', s)
            s = re.sub(r'`([^`]+)`', r'\1', s)
            s = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', s)
            s = re.sub(r'\s+', ' ', s).strip()
            return s

        parts = []
        contrib = (paper_entry.get('core_contribution') or '').strip()
        if contrib:
            parts.append(_strip_md(contrib))
        summary_field = (paper_entry.get('summary') or '').strip()
        if summary_field:
            first_para = summary_field.split('\n\n', 1)[0]
            parts.append(_strip_md(first_para))
        if not parts:
            for line in body_markdown.split('\n'):
                s = line.strip()
                if not s or s.startswith(('#', '!', '|', '>', '-', '*', '`')):
                    continue
                parts.append(_strip_md(s))
                if sum(len(p) for p in parts) > 200:
                    break

        text = ' '.join(parts)
        if len(text) <= 300:
            return text
        # Try to truncate at sentence boundary near the limit (≤300 chars)
        cut = text[:300]
        for sep in ['。', '！', '？', '. ', '! ', '? ']:
            idx = cut.rfind(sep)
            if idx >= 150:
                return cut[:idx + len(sep)].rstrip()
        # No sentence boundary: hard cut at 299 chars + '…' = exactly 300 chars
        return text[:299].rstrip() + '…'

    tldr_text = _build_tldr(p, body_md)

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
.md-table {{
  width: 100%; border-collapse: collapse; margin: 12px 0;
  font-size: 0.85rem;
}}
.md-table th, .md-table td {{
  border: 1px solid var(--bd); padding: 8px 12px; text-align: left;
}}
.md-table th {{
  background: #f8fafc; font-weight: 700;
}}
.content .katex-display {{
  overflow-x: auto; overflow-y: hidden;
  padding: 4px 0; margin: 16px 0;
}}
.back {{ display: inline-block; margin: 24px; font-size: 0.9rem; font-weight: 600; }}
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
</body>
</html>"""

    page = sanitize_html(page)

    out_path = os.path.join(PAPERS_DIR, f"{pid}.html")
    with open(out_path, "w") as f:
        f.write(page)
    print(f"  Wrote papers/{pid}.html")

print("Sync complete.")
PYEOF

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
