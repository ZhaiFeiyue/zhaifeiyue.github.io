#!/usr/bin/env bash
set -euo pipefail

PAPER_DB="$HOME/.cursor/paper-db"
SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
PAPERS_DIR="$SITE_DIR/papers"

mkdir -p "$PAPERS_DIR"

python3 - "$PAPER_DB" "$SITE_DIR" << 'PYEOF'
import json, os, sys, re, html
from pathlib import Path

DB_DIR = sys.argv[1]
SITE_DIR = sys.argv[2]
PAPERS_DIR = os.path.join(SITE_DIR, "papers")

with open(os.path.join(DB_DIR, "papers.json")) as f:
    db = json.load(f)

papers = sorted(db["papers"], key=lambda p: p.get("date_read", ""), reverse=True)

CAT_COLORS = {
    "algorithm": "#16a34a", "kernel": "#ea580c", "framework": "#2563eb",
    "llm": "#9333ea", "agent": "#dc2626"
}
CAT_LABELS = {
    "algorithm": "Algorithm", "kernel": "Kernel", "framework": "Framework",
    "llm": "LLM", "agent": "Agent"
}

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
  <a href="/float.html">Tools</a>
  <a href="https://github.com/ZhaiFeiyue" target="_blank">GitHub</a>
</nav>"""

FONTS = '<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=Noto+Sans+SC:wght@400;600;700&family=Noto+Serif+SC:wght@400;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">'

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
    depth_badge = '<span style="color:#16a34a;font-weight:600;font-size:0.75rem">精读</span>' if depth == "deep" else '<span style="color:#d97706;font-weight:600;font-size:0.75rem">粗读</span>'
    paper_rows += f"""<a class="paper-row" href="papers/{pid}.html">
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
<title>AI Infra Paper Readings — Feiyue Zhai</title>
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
.stats {{
  display: flex; gap: 24px; justify-content: center; margin: 24px 0 8px;
  flex-wrap: wrap;
}}
.stat {{
  font-size: 0.85rem; color: var(--mt);
}}
.stat b {{ font-size: 1.4rem; font-weight: 800; display: block; }}
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
</style>
</head>
<body>
{NAV_HTML}
<div class="hero">
  <h1>AI Infra Paper Readings</h1>
  <p>AI 基础设施论文精读笔记</p>
  <div class="stats">
    <div class="stat"><b>{total}</b>papers</div>
    {"".join(f'<div class="stat"><b style="color:{CAT_COLORS.get(c,"#6b7280")}">{n}</b>{CAT_LABELS.get(c,c)}</div>' for c, n in sorted(cat_counts.items(), key=lambda x:-x[1]))}
  </div>
</div>
<div class="w">
{paper_rows if paper_rows else '<div style="text-align:center;padding:40px;color:var(--mt)">还没有论文。</div>'}
</div>
<footer>Built with paper-reader skill · Hosted on GitHub Pages</footer>
</body>
</html>"""

with open(os.path.join(SITE_DIR, "index.html"), "w") as f:
    f.write(index_html)
print(f"Wrote index.html ({total} papers)")

# ============================================================
# PER-PAPER PAGES
# ============================================================
def md_to_html(md_text):
    """Minimal markdown to HTML (headings, lists, bold, tables, images, blockquotes, code blocks)."""
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
                out.append('<table class="md-table"><tr>' + ''.join(f'<th>{c}</th>' for c in cells) + '</tr>')
                in_table = True
            else:
                out.append('<tr>' + ''.join(f'<td>{c}</td>' for c in cells) + '</tr>')
            continue

        if stripped.startswith('!['):
            m = re.match(r'!\[([^\]]*)\]\(([^)]+)\)', stripped)
            if m:
                alt, src = m.group(1), m.group(2)
                out.append(f'<figure><img src="{src}" alt="{html.escape(alt)}" style="max-width:100%;border-radius:8px"><figcaption>{html.escape(alt)}</figcaption></figure>')
                continue

        if stripped.startswith('> '):
            out.append(f'<blockquote>{stripped[2:]}</blockquote>')
            continue

        if stripped.startswith('### '):
            if in_ul:
                out.append('</ul>'); in_ul = False
            out.append(f'<h3>{stripped[4:]}</h3>')
            continue
        if stripped.startswith('## '):
            if in_ul:
                out.append('</ul>'); in_ul = False
            anchor = re.sub(r'[^a-z0-9]+', '-', stripped[3:].lower()).strip('-')
            out.append(f'<h2 id="{anchor}">{stripped[3:]}</h2>')
            continue

        if stripped.startswith('- '):
            if not in_ul:
                out.append('<ul>'); in_ul = True
            content = stripped[2:]
            content = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', content)
            out.append(f'<li>{content}</li>')
            continue
        else:
            if in_ul:
                out.append('</ul>'); in_ul = False

        stripped = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', stripped)
        stripped = re.sub(r'`([^`]+)`', r'<code>\1</code>', stripped)

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

    # Split into 粗读 and 精读 at "## Deep Analysis"
    split_marker = "## Deep Analysis"
    if split_marker in md:
        idx = md.index(split_marker)
        rough_md = md[:idx].strip()
        # Remove leading --- separator if present
        deep_md = md[idx:].strip()
        if rough_md.endswith('---'):
            rough_md = rough_md[:-3].strip()
    else:
        rough_md = md.strip()
        deep_md = ""

    # Skip the first H1 title line in rough_md (already in page header)
    rough_lines = rough_md.split('\n')
    skip = 0
    for i, l in enumerate(rough_lines):
        if l.startswith('# '):
            skip = i + 1
            continue
        if l.startswith('>') and i <= skip + 3:
            skip = i + 1
            continue
        break
    rough_md = '\n'.join(rough_lines[skip:])

    rough_html = md_to_html(rough_md)
    deep_html = md_to_html(deep_md) if deep_md else ""

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
.section-divider {{
  max-width: 960px; margin: 32px auto; padding: 0 24px;
}}
.section-divider hr {{
  border: none; border-top: 3px solid var(--accent); opacity: 0.3;
}}
.section-label {{
  display: inline-block; background: var(--accent); color: #fff;
  font-size: 0.82rem; font-weight: 700; padding: 4px 16px;
  border-radius: 999px; margin-bottom: 16px;
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
.content figcaption {{
  font-size: 0.8rem; color: var(--mt); margin-top: 6px;
  font-style: italic;
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
<div class="w content">
  <span class="section-label">粗读 Overview</span>
  {rough_html}
</div>
{"<div class='section-divider'><hr></div><div class='w content'><span class='section-label'>精读 Deep Analysis</span>" + deep_html + "</div>" if deep_html else ""}
<footer>Built with paper-reader skill · <a href="/">Back to index</a></footer>
</body>
</html>"""

    out_path = os.path.join(PAPERS_DIR, f"{pid}.html")
    with open(out_path, "w") as f:
        f.write(page)
    print(f"  Wrote papers/{pid}.html")

print("Sync complete.")
PYEOF

echo "Done."
