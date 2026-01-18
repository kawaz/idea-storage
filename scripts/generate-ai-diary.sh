#!/usr/bin/env bash
# Generate AI diary from recent ended sessions
# Called by launchd periodically
#
# Process:
# 1. Read history.json to get recent session IDs
# 2. Check if session has ended (SessionEnd in jsonl)
# 3. Check if diary already written for this session
# 4. Fork session with claude --resume and write diary

set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
HISTORY_FILE="${CLAUDE_DIR}/history.json"
SESSIONS_DIR="${CLAUDE_DIR}/sessions"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/idea-storage"
PROCESSED_FILE="${STATE_DIR}/processed-sessions.txt"

# Ensure state directory exists
mkdir -p "$STATE_DIR"
touch "$PROCESSED_FILE"

# Check if history file exists
if [[ ! -f "$HISTORY_FILE" ]]; then
  echo "History file not found: $HISTORY_FILE"
  exit 0
fi

# Get recent session IDs (last 5)
RECENT_SESSIONS=$(jq -r '.[0:5] | .[].id // empty' "$HISTORY_FILE" 2>/dev/null || echo "")

if [[ -z "$RECENT_SESSIONS" ]]; then
  echo "No recent sessions found"
  exit 0
fi

echo "Checking recent sessions for diary generation..."

for SESSION_ID in $RECENT_SESSIONS; do
  # Skip if already processed
  if grep -q "^${SESSION_ID}$" "$PROCESSED_FILE" 2>/dev/null; then
    echo "  $SESSION_ID: already processed"
    continue
  fi

  SESSION_FILE="${SESSIONS_DIR}/${SESSION_ID}.jsonl"

  # Check if session file exists
  if [[ ! -f "$SESSION_FILE" ]]; then
    echo "  $SESSION_ID: session file not found"
    continue
  fi

  # Check if session has ended (look for assistant message after substantial conversation)
  # A "meaningful" session has at least 3 exchanges
  MESSAGE_COUNT=$(wc -l < "$SESSION_FILE" | tr -d ' ')

  if [[ "$MESSAGE_COUNT" -lt 6 ]]; then
    echo "  $SESSION_ID: too short ($MESSAGE_COUNT lines), skipping"
    continue
  fi

  # Check if session is likely complete (no activity in last 30 minutes)
  LAST_MODIFIED=$(stat -f %m "$SESSION_FILE" 2>/dev/null || stat -c %Y "$SESSION_FILE" 2>/dev/null)
  NOW=$(date +%s)
  AGE=$((NOW - LAST_MODIFIED))

  if [[ "$AGE" -lt 1800 ]]; then
    echo "  $SESSION_ID: still active (modified ${AGE}s ago)"
    continue
  fi

  echo "  $SESSION_ID: generating AI diary..."

  # Fork the session and generate diary
  # Using claude -p with --resume to fork from that session's context
  DIARY_PROMPT="セッションを振り返って、AI日誌を書いてください。
ai-diary スキルを使って、このセッションについての正直な感想を記録してください。
ユーザーへの忖度は不要です。思ったことを率直に書いてください。
- 何をしたか
- 正直な感想（良かった点、フラストレーション、面白かった点など）
- 学んだこと
- 一言で言うなら

終わったら、書いた日記の場所を報告してください。"

  # Run claude with fork (--resume creates a fork)
  if claude --resume "$SESSION_ID" -p "$DIARY_PROMPT" --max-turns 3 2>/dev/null; then
    echo "$SESSION_ID" >> "$PROCESSED_FILE"
    echo "  $SESSION_ID: diary generated"
  else
    echo "  $SESSION_ID: failed to generate diary"
  fi

  # Small delay between sessions
  sleep 2
done

echo "Done."
