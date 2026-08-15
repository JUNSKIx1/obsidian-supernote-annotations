#!/usr/bin/env bash
# Build the plugin and copy the three shipped files into a vault.
#
#   bash scripts/deploy-to-vault.sh                 # uses $VAULT, or the default below
#   VAULT="/path/to/vault" bash scripts/deploy-to-vault.sh
#
# Only main.js, manifest.json and styles.css are copied — exactly what a release
# ships and what Obsidian loads. Sources and .git stay in this repo, which is the
# whole point: a .git directory inside a synced vault is a corruption waiting to
# happen.
#
# Obsidian caches its config in memory and rewrites .obsidian/*.json when it
# exits, so enable the plugin through the UI rather than editing that file.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT="${VAULT:-$HOME/Nextcloud/ME&ME}"
PLUGIN_ID="supernote-annotations"
DEST="$VAULT/.obsidian/plugins/$PLUGIN_ID"

[ -d "$VAULT/.obsidian" ] || { echo "✗ no .obsidian directory in $VAULT — is that a vault?"; exit 1; }

echo "building…"
( cd "$REPO" && npm run build --silent )

mkdir -p "$DEST"
for f in main.js manifest.json styles.css; do
  [ -f "$REPO/$f" ] || { echo "✗ missing $REPO/$f"; exit 1; }
  cp "$REPO/$f" "$DEST/$f"
done

printf '✓ deployed to %s\n' "$DEST"
printf '  main.js %s KB\n' "$(( $(stat -c%s "$DEST/main.js") / 1024 ))"
echo "  restart Obsidian (or toggle the plugin off and on) to load it"
