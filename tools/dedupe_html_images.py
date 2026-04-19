#!/usr/bin/env python3
"""Post-write deduplicator for any HTML file with embedded base64 images.

Hand-written reader HTMLs (Phase 10 LLM output) regularly embed the same
PNG twice — once as a hero figure, then again inside a section. Rather
than fix each by hand, this tool walks the HTML, hashes each base64
chunk, and replaces every 2nd+ occurrence with a slim "↑ see above"
pointer (preserving the surrounding caption text).

Usage:
    python3 dedupe_html_images.py path/to/file.html [path/to/another.html ...]
    python3 dedupe_html_images.py --all        # scan readers/ and papers/

Idempotent: running twice does nothing on already-clean files.
"""
from __future__ import annotations
import hashlib
import re
import sys
from pathlib import Path

READERS_DIR = Path("~/.cursor/paper-db/readers").expanduser()
PAPERS_DIR = Path("/apps/feiyue/upstream/zhaifeiyue.github.io/papers")

# Match an <img> with embedded base64 (and optionally a wrapping <figure>
# with a <figcaption>). Capture: full, b64 hash material, alt text, caption.
IMG_RE = re.compile(
    r"""
    (?P<wrap_open><figure[^>]*>\s*)?
    <img\s+
        (?:[^>]*?\s)?
        src="data:image/(?:png|jpeg|gif);base64,(?P<b64>[A-Za-z0-9+/=]{200,})"
        (?:[^>]*?\s)?
        (?:alt="(?P<alt>[^"]*)")?
        [^>]*
    >
    \s*
    (?:<figcaption[^>]*>(?P<caption>[^<]*)</figcaption>\s*)?
    (?P<wrap_close></figure>)?
    """,
    re.VERBOSE | re.DOTALL,
)


def dedupe_html(text: str) -> tuple[str, int]:
    """Return (dedupled_text, n_replaced)."""
    seen: dict[str, str] = {}  # b64_hash -> first label
    replaced = 0

    def repl(m: re.Match) -> str:
        nonlocal replaced
        b64 = m.group("b64") or ""
        alt = (m.group("alt") or "").strip()
        caption = (m.group("caption") or "").strip()
        h = hashlib.md5(b64.encode()).hexdigest()
        if h not in seen:
            seen[h] = alt or caption or "image"
            return m.group(0)
        replaced += 1
        label = seen[h]
        return (
            '<div class="fig-ref" '
            'style="display:inline-flex;align-items:center;gap:6px;'
            'padding:4px 10px;margin:8px 0;background:#f1f5f9;'
            'border-radius:6px;font-size:0.85rem;color:#6b7280">'
            '<span style="font-weight:700;color:#2563eb">↑</span> '
            f'<em>{label}</em> '
            '<span style="font-size:0.75rem;opacity:0.7">(see above)</span>'
            '</div>'
        )

    new_text = IMG_RE.sub(repl, text)
    return new_text, replaced


def process_file(path: Path) -> int:
    text = path.read_text(encoding="utf-8")
    new_text, n = dedupe_html(text)
    if n:
        path.write_text(new_text, encoding="utf-8")
    return n


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 1
    if argv[0] == "--all":
        seen = set()
        files = []
        for d in (READERS_DIR, PAPERS_DIR):
            if not d.exists():
                continue
            for p in sorted(d.glob("*.html")):
                rp = p.resolve()
                if rp not in seen:
                    seen.add(rp)
                    files.append(p)
    else:
        files = [Path(p) for p in argv]

    total = 0
    affected = 0
    for f in files:
        if not f.exists():
            print(f"  skip (not found): {f}")
            continue
        n = process_file(f)
        if n:
            print(f"  deduped {n} extra embed(s) in {f.name}")
            affected += 1
            total += n
    print()
    print(f"Done: {total} extra embed(s) removed across {affected} file(s) "
          f"(scanned {len(files)} total).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
