#!/bin/sh
# Copy the built plugin into a vault: sh tools/deploy.sh [vault path]
# Real files, not a symlink, so Obsidian Sync carries them to other devices.
# data.json (the settings) is never touched. Also writes CHANGELOG.md into the
# vault as a note. Reload the plugin afterwards.
set -e
cd "$(dirname "$0")/.."
VAULT="${1:-$HOME/LCARS}"
DEST="$VAULT/.obsidian/plugins/lcars-obsidian"
python3 tools/build_styles.py
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
echo "deployed to $DEST"

# The changelog goes in as a note, so it can be read and linked in the vault.
# It is overwritten on every deploy: edit CHANGELOG.md in the repo, not the note.
NOTE="${LCARS_CHANGELOG_NOTE:-$VAULT/05 Projects/LCARS Interface/LCARS for Obsidian - Changelog.md}"
mkdir -p "$(dirname "$NOTE")"
{
  printf -- '---\ntags:\n  - lcars\n  - changelog\n---\n'
  printf '> Generated copy of CHANGELOG.md from the lcars-for-obsidian repo. Edit it there; this note is overwritten on deploy.\n\n'
  tail -n +2 CHANGELOG.md | sed '1{/^$/d;}'
} > "$NOTE"
echo "changelog written to $NOTE"
