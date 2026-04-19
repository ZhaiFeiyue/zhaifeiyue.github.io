#!/usr/bin/env python3
"""Post-sync sanity: every published HTML must NOT embed the same PNG twice.

This catches bugs in sync.sh's image-injection logic (e.g. the
`inject_images_inline` whitespace-aware regression) that the source
markdown / image-dir checks would miss.

Exit 0 if clean, exit 1 if any page has duplicates.

Usage:
    python3 check_published_dupes.py /apps/feiyue/upstream/zhaifeiyue.github.io
"""
from __future__ import annotations
import hashlib
import re
import sys
from collections import Counter
from pathlib import Path


def main(site_dir: Path) -> int:
    seen_paths = set()
    pages = []
    for p in sorted((site_dir / "papers").glob("*.html")):
        rp = p.resolve()
        if rp not in seen_paths:
            seen_paths.add(rp)
            pages.append(p)
    readers_dir = Path.home() / ".cursor/paper-db/readers"
    if readers_dir.exists():
        for p in sorted(readers_dir.glob("*.html")):
            rp = p.resolve()
            if rp not in seen_paths:
                seen_paths.add(rp)
                pages.append(p)

    bad_pages: list[tuple[str, int, list[tuple[str, int]]]] = []

    pattern = re.compile(r'data:image/(?:png|jpeg|gif);base64,([A-Za-z0-9+/=]{200,})')
    for p in pages:
        try:
            text = p.read_text(encoding="utf-8")
        except Exception:
            continue
        b64s = pattern.findall(text)
        if not b64s:
            continue
        hashes = [hashlib.md5(b.encode()).hexdigest()[:10] for b in b64s]
        c = Counter(hashes)
        dups = [(h, n) for h, n in c.items() if n > 1]
        if dups:
            bad_pages.append((str(p), len(b64s) - len(c), dups))

    if not bad_pages:
        print(f"✅ No duplicate image embeds across {len(pages)} published page(s).")
        return 0

    print(f"❌ Duplicate image embeds in {len(bad_pages)} page(s):")
    total_extra = 0
    for path, extras, dups in bad_pages:
        total_extra += extras
        name = Path(path).name
        dup_str = ", ".join(f"{h[:8]}×{n}" for h, n in dups)
        print(f"  {name}: +{extras} extra embed(s)   [{dup_str}]")
    print(f"\nTotal extra (duplicate) embeds: {total_extra}")
    print("Most common cause: sync.sh's inject_images_inline auto-inserted a")
    print("duplicate image link because notes have a blank line between the")
    print("`### Figure N` heading and the explicit `![...](...)` link.")
    return 1


if __name__ == "__main__":
    site = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
    sys.exit(main(site))
