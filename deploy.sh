#!/usr/bin/env bash
# Deploy built plugin files into a vault. Usage: ./deploy.sh <vault-path>
set -euo pipefail
VAULT="${1:?usage: ./deploy.sh <vault-path>}"
DST="$VAULT/.obsidian/plugins/aios-dashboard"
npm run build
mkdir -p "$DST"
cp main.js manifest.json styles.css "$DST/"
echo "deployed to $DST"

# Vault exporter scripts: the repo (vault-scripts/) is the canonical home;
# the vault copies under Operations/scripts/ are deploy artifacts.
SCRIPTS_DST="$VAULT/Operations/scripts"
mkdir -p "$SCRIPTS_DST"
cp vault-scripts/*.mjs "$SCRIPTS_DST/"
echo "deployed vault scripts to $SCRIPTS_DST"
