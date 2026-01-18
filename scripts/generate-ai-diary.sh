#!/usr/bin/env bash
# Generate AI diary from recent ended sessions
# Called by launchd periodically
#
# Process:
# 1. Read history.json to get recent session IDs
# 2. Check if session has ended (no activity for 30min)
# 3. Check if diary already written for this session
# 4. Fork session with claude --resume and write diary
# 5. If context overflow, progressively trim and retry

set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
HISTORY_FILE="${CLAUDE_DIR}/history.json"
SESSIONS_DIR="${CLAUDE_DIR}/sessions"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/idea-storage"
PROCESSED_FILE="${STATE_DIR}/processed-sessions.txt"

# Minimum lines to keep (below this we give up)
MIN_LINES=50

DIARY_PROMPT="セッションを振り返って、AI日誌を書いてください。
ai-diary スキルを使って、このセッションについての正直な感想を記録してください。
ユーザーへの忖度は不要です。思ったことを率直に書いてください。
- 何をしたか
- 正直な感想（良かった点、フラストレーション、面白かった点など）
- 学んだこと
- 一言で言うなら

終わったら、書いた日記の場所を報告してください。"

# Ensure state directory exists
mkdir -p "$STATE_DIR"
touch "$PROCESSED_FILE"

# Try to generate diary with progressively smaller context
# Returns 0 on success, 1 on failure
try_generate_diary() {
  local session_id="$1"
  local session_file="$2"
  local total_lines="$3"

  local resume_id="$session_id"
  local temp_file=""
  local current_lines="$total_lines"

  # Try with full content first, then progressively trim
  # Ratios: 100%, 95%, 90%, 85%, 80%, 70%, 60%, 50%, 30%
  local ratios=(100 95 90 85 80 70 60 50 30)

  for ratio in "${ratios[@]}"; do
    current_lines=$((total_lines * ratio / 100))

    # Don't go below minimum
    if [[ "$current_lines" -lt "$MIN_LINES" ]]; then
      current_lines="$MIN_LINES"
    fi

    # Clean up previous temp file if exists
    if [[ -n "$temp_file" && -f "$temp_file" ]]; then
      rm -f "$temp_file"
    fi

    # Create trimmed copy if not using full file
    if [[ "$current_lines" -lt "$total_lines" ]]; then
      local temp_id="diary-tmp-$(date +%s)-$$-${ratio}"
      temp_file="${SESSIONS_DIR}/${temp_id}.jsonl"
      tail -n "$current_lines" "$session_file" > "$temp_file"
      resume_id="$temp_id"
      echo "    Trying with $current_lines lines ($ratio%)..."
    else
      resume_id="$session_id"
      temp_file=""
      echo "    Trying with full session ($total_lines lines)..."
    fi

    # Attempt to generate diary
    if claude --resume "$resume_id" -p "$DIARY_PROMPT" --max-turns 3 2>&1; then
      # Success! Clean up and return
      if [[ -n "$temp_file" && -f "$temp_file" ]]; then
        rm -f "$temp_file"
      fi
      return 0
    fi

    echo "    Failed at $ratio%, trying smaller..."

    # If we're already at minimum, give up
    if [[ "$current_lines" -le "$MIN_LINES" ]]; then
      break
    fi
  done

  # Final cleanup
  if [[ -n "$temp_file" && -f "$temp_file" ]]; then
    rm -f "$temp_file"
  fi

  return 1
}

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

  # Check if session has ended (look for substantial conversation)
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

  echo "  $SESSION_ID: generating AI diary ($MESSAGE_COUNT lines)..."

  if try_generate_diary "$SESSION_ID" "$SESSION_FILE" "$MESSAGE_COUNT"; then
    echo "$SESSION_ID" >> "$PROCESSED_FILE"
    echo "  $SESSION_ID: diary generated successfully"
  else
    echo "  $SESSION_ID: failed to generate diary (even with minimum context)"
  fi

  # Small delay between sessions
  sleep 2
done

echo "Done."
