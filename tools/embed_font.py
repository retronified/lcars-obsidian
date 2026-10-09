#!/usr/bin/env python3
"""Rebuild the Antonio @font-face block in theme/lcars-core.css from fonts/Antonio/.

  embed_font.py

Obsidian loads a stylesheet as inline CSS, so a font file next to it cannot be reached by
a relative url(). The font is embedded as a base64 data URI instead. Run this after
replacing the font file. It changes only the text between the two ANTONIO markers.
"""
import base64, os, re, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TTF = os.path.join(ROOT, "fonts", "Antonio", "Antonio-VariableFont_wght.ttf")
CSS = os.path.join(ROOT, "theme", "lcars-core.css")
b64 = base64.b64encode(open(TTF, "rb").read()).decode()
block = ("/* ANTONIO:BEGIN. Antonio, SIL Open Font License 1.1, (c) 2013 The Antonio Project Authors.\n"
         "   Embedded so the theme needs no font install. License: fonts/Antonio/OFL.txt */\n"
         "@font-face {\n  font-family: \"Antonio\";\n  font-style: normal;\n  font-weight: 100 700;\n  font-display: swap;\n"
         "  src: url(\"data:font/ttf;base64," + b64 + "\") format(\"truetype\");\n}\n/* ANTONIO:END */")
s = open(CSS).read()
if "/* ANTONIO:BEGIN" in s:
    s = re.sub(r"/\* ANTONIO:BEGIN.*?/\* ANTONIO:END \*/", lambda m: block, s, flags=re.S)
else:
    anchor = "/* ─────────────────────────────────────────────\n   0b. COLORS"
    if anchor not in s: sys.exit("anchor not found")
    s = s.replace(anchor, block + "\n\n" + anchor, 1)
open(CSS, "w").write(s)
print("embedded", len(b64), "base64 bytes")
