#!/usr/bin/env bash
# Install launchd jobs for idea-storage
# - User diary: daily at 00:30
# - AI diary: every hour

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/.local/state/idea-storage"

# Create log directory
mkdir -p "$LOG_DIR"

install_job() {
  local NAME="$1"
  local SCRIPT="$2"
  local INTERVAL_TYPE="$3"  # "daily" or "hourly"

  local PLIST_PATH="$HOME/Library/LaunchAgents/com.idea-storage.${NAME}.plist"

  if [[ "$INTERVAL_TYPE" == "daily" ]]; then
    INTERVAL_XML='<key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>0</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>'
  else
    # Hourly
    INTERVAL_XML='<key>StartInterval</key>
    <integer>3600</integer>'
  fi

  cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.idea-storage.${NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${SCRIPT}</string>
    </array>
    ${INTERVAL_XML}
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/${NAME}-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/${NAME}-stderr.log</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH"

  echo "Installed: $PLIST_PATH"
}

echo "Installing idea-storage launchd jobs..."
echo ""

# User diary - daily at 00:30
install_job "user-diary" "${SCRIPT_DIR}/generate-user-diary.sh" "daily"
echo "  -> User diary: daily at 00:30"

# AI diary - every hour
install_job "ai-diary" "${SCRIPT_DIR}/generate-ai-diary.sh" "hourly"
echo "  -> AI diary: every hour"

echo ""
echo "Logs: $LOG_DIR"
echo ""
echo "To uninstall:"
echo "  launchctl unload ~/Library/LaunchAgents/com.idea-storage.user-diary.plist"
echo "  launchctl unload ~/Library/LaunchAgents/com.idea-storage.ai-diary.plist"
echo "  rm ~/Library/LaunchAgents/com.idea-storage.*.plist"
