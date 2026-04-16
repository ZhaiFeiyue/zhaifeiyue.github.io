#!/usr/bin/env bash
set -euo pipefail

PAPER_DB="$HOME/.cursor/paper-db"
SITE_DIR="$(cd "$(dirname "$0")" && pwd)"
PAPERS_DIR="$SITE_DIR/papers"
READERS_DIR="$PAPERS_DIR/readers"

mkdir -p "$READERS_DIR"

cp "$PAPER_DB/overview.html" "$PAPERS_DIR/index.html"
for f in algorithm kernel framework llm agent; do
  [ -f "$PAPER_DB/$f.html" ] && cp "$PAPER_DB/$f.html" "$PAPERS_DIR/"
done

if [ -d "$PAPER_DB/readers" ]; then
  for f in "$PAPER_DB/readers"/*-reader.html; do
    [ -f "$f" ] && cp "$f" "$READERS_DIR/"
  done
fi

python3 - "$PAPER_DB/papers.json" "$SITE_DIR/index.html" << 'PYEOF'
import json, sys, re
from datetime import datetime

db_path, html_path = sys.argv[1], sys.argv[2]

with open(db_path) as f:
    db = json.load(f)

papers = sorted(db["papers"], key=lambda p: p.get("date_read", ""), reverse=True)

cat_counts = {}
for p in papers:
    cat_counts[p["category"]] = cat_counts.get(p["category"], 0) + 1

cat_colors = {
    "algorithm": "#16a34a", "kernel": "#ea580c", "framework": "#2563eb",
    "llm": "#9333ea", "agent": "#dc2626"
}

tl_html = ""
for p in papers[:20]:
    color = cat_colors.get(p["category"], "#6b7280")
    cat_label = p["category"].upper()
    date = p.get("date_read", "")
    title = p["title"]
    pid = p["id"]
    reader_link = f'papers/readers/{pid}-reader.html'
    tl_html += (
        f'<div class="tl-item">'
        f'<span class="tl-date">{date}</span>'
        f'<span class="tl-cat" style="background:{color}">{cat_label}</span>'
        f'<span class="tl-title"><a href="{reader_link}">{title}</a></span>'
        f'</div>\n'
    )

if not tl_html:
    tl_html = '<div class="empty">还没有论文精读记录。读第一篇论文后这里会自动更新。</div>'

with open(html_path) as f:
    html = f.read()

for cat in ["algorithm", "kernel", "framework", "llm", "agent"]:
    count = cat_counts.get(cat, 0)
    display = str(count) if count > 0 else "—"
    html = re.sub(
        rf'(<a class="card" href="papers/{cat}\.html"[^>]*>)\s*<div class="count"[^>]*>[^<]*</div>',
        rf'\1\n    <div class="count" style="color: var(--{cat[:4] if cat != "framework" else "fwk"})">{display}</div>',
        html
    )

html = re.sub(
    r'<div class="timeline">.*?</div>\s*</div>',
    f'<div class="timeline">\n{tl_html}</div>\n</div>',
    html,
    flags=re.DOTALL,
    count=1
)

with open(html_path, "w") as f:
    f.write(html)

print(f"Updated index.html: {len(papers)} papers, {len(cat_counts)} categories")
PYEOF

echo "Sync complete. Files updated in $SITE_DIR"
echo "Run 'cd $SITE_DIR && git add -A && git commit -m \"update\" && git push' to publish."
