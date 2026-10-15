#!/bin/sh
# Copy the built plugin into a vault: sh tools/deploy.sh [vault path]
# Real files, not a symlink, so Obsidian Sync carries them to other devices.
# data.json (the settings) is never touched. Reload the plugin afterwards.
set -e
cd "$(dirname "$0")/.."
VAULT="${1:-$HOME/LCARS}"
DEST="$VAULT/.obsidian/plugins/lcars-obsidian"
python3 tools/build_styles.py
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
echo "deployed to $DEST"
