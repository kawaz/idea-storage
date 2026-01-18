#!/usr/bin/env bash
# Generate user diary - called by launchd daily
# Generates diary for yesterday

set -euo pipefail

# Find the plugin root (this script is in scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"

# Use the skill script
exec bash "$PLUGIN_ROOT/skills/user-diary/scripts/generate.sh"
