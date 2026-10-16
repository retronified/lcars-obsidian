#!/usr/bin/env python3
"""Make README images repo-ready after editing the README in Obsidian.

Obsidian embeds pasted images as ![[name.png]] (or links into the vault's
attachment folder). GitHub can't resolve either. This copies each such image
into docs/screenshots/ and rewrites the embed as a relative markdown link.
Embeds that already point at docs/screenshots/ are left alone, so running it
repeatedly is safe.
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path
from urllib.parse import unquote

REPO = Path(__file__).resolve().parent.parent
README = REPO / "README.md"
DEST = REPO / "docs" / "screenshots"
VAULT = Path("/Users/phillip/LCARS")
ASSETS = VAULT / "98 Assets"
IMG = r"(?:png|jpe?g|gif|webp|svg)"

WIKI = re.compile(rf"!\[\[([^\]|#]+\.{IMG})(?:\|[^\]]*)?\]\]", re.I)
MD = re.compile(rf"!\[([^\]]*)\]\(<?([^)>]+\.{IMG})>?\)", re.I)


def find_source(ref: str) -> Path | None:
    ref = unquote(ref)
    for candidate in (REPO / ref, VAULT / ref, ASSETS / ref):
        if candidate.is_file():
            return candidate
    name = Path(ref).name
    for found in ASSETS.rglob(name) if ASSETS.is_dir() else []:
        return found
    return None


def adopt(ref: str) -> str | None:
    """Copy the image into docs/screenshots/ and return the new relative path."""
    if unquote(ref).startswith("docs/screenshots/") or re.match(r"https?://", ref):
        return None
    src = find_source(ref)
    if src is None:
        print(f"not found, left as is: {ref}", file=sys.stderr)
        return None
    name = re.sub(r"\s+", "-", src.name)
    DEST.mkdir(parents=True, exist_ok=True)
    target = DEST / name
    if not target.exists():
        shutil.copy2(src, target)
    return f"docs/screenshots/{name}"


def main() -> int:
    text = README.read_text()

    def wiki(m: re.Match) -> str:
        new = adopt(m.group(1))
        return m.group(0) if new is None else f"![{Path(new).stem}]({new})"

    def md(m: re.Match) -> str:
        new = adopt(m.group(2))
        return m.group(0) if new is None else f"![{m.group(1) or Path(new).stem}]({new})"

    out = MD.sub(md, WIKI.sub(wiki, text))
    if out != text:
        README.write_text(out)
        print("README images updated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
