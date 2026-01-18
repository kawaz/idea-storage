#!/usr/bin/env bash
# Generate AI diary from recent ended sessions
# Called by launchd periodically or manually
#
# Process:
# 1. Parse ~/.claude/history.jsonl to find sessions
# 2. Check if session has ended (no activity for 30min)
# 3. Check if diary already written for this session
# 4. Fork session with claude --resume and write diary
# 5. If context overflow, progressively trim and retry

set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
HISTORY_FILE="${CLAUDE_DIR}/history.jsonl"
PROJECTS_DIR="${CLAUDE_DIR}/projects"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/idea-storage"
PROCESSED_FILE="${STATE_DIR}/processed-sessions.txt"

# Minimum lines to keep (below this we give up)
MIN_LINES=50
# Minimum age in seconds before processing (2 hours - accounts for breaks, multi-agent work, etc.)
MIN_AGE_SECONDS=7200
# Minimum entries to consider a "meaningful" session
MIN_SESSION_ENTRIES=3

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

# Find session file by ID
find_session_file() {
  local session_id="$1"
  find "$PROJECTS_DIR" -name "${session_id}.jsonl" -type f 2>/dev/null | head -1
}

# Generate UUID v4
generate_uuid() {
  if command -v uuidgen &>/dev/null; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  else
    # Fallback: generate pseudo-UUID
    printf '%04x%04x-%04x-%04x-%04x-%04x%04x%04x\n' \
      $RANDOM $RANDOM $RANDOM \
      $(($RANDOM & 0x0fff | 0x4000)) \
      $(($RANDOM & 0x3fff | 0x8000)) \
      $RANDOM $RANDOM $RANDOM
  fi
}

# Try to generate diary with progressively smaller context
try_generate_diary() {
  local session_id="$1"
  local session_file="$2"
  local total_lines="$3"

  local resume_id="$session_id"
  # Put temp files in the same project dir so claude can find them
  local project_dir
  project_dir=$(dirname "$session_file")
  local temp_file=""
  local current_lines="$total_lines"

  # Try with full content first, then trim 5% at a time
  local ratio=100

  while [[ "$ratio" -ge 10 ]]; do
    current_lines=$((total_lines * ratio / 100))

    if [[ "$current_lines" -lt "$MIN_LINES" ]]; then
      current_lines="$MIN_LINES"
    fi

    # Clean up previous temp file
    if [[ -n "$temp_file" && -f "$temp_file" ]]; then
      rm -f "$temp_file"
    fi

    # Create trimmed copy if not using full file
    if [[ "$current_lines" -lt "$total_lines" ]]; then
      # Generate UUID for temp session so claude can find it
      local temp_uuid
      temp_uuid=$(generate_uuid)
      temp_file="${project_dir}/${temp_uuid}.jsonl"
      tail -n "$current_lines" "$session_file" > "$temp_file"
      resume_id="$temp_uuid"
      echo "    Trying with $current_lines lines ($ratio%)..."
    else
      resume_id="$session_id"
      temp_file=""
      echo "    Trying with full session ($total_lines lines)..."
    fi

    # Attempt to generate diary
    if claude --resume "$resume_id" -p "$DIARY_PROMPT" --max-turns 3 2>&1; then
      [[ -n "$temp_file" && -f "$temp_file" ]] && rm -f "$temp_file"
      return 0
    fi

    echo "    Failed at $ratio%, trying smaller..."

    if [[ "$current_lines" -le "$MIN_LINES" ]]; then
      break
    fi

    ratio=$((ratio - 5))
  done

  [[ -n "$temp_file" && -f "$temp_file" ]] && rm -f "$temp_file"
  return 1
}

# Check if history file exists
if [[ ! -f "$HISTORY_FILE" ]]; then
  echo "History file not found: $HISTORY_FILE"
  exit 0
fi

echo "Checking recent sessions for diary generation..."

# Get recent ended sessions from history.jsonl
# Group by sessionId, check last activity timestamp
NOW=$(date +%s)

jq -sc --argjson min_age "$MIN_AGE_SECONDS" --argjson min_entries "$MIN_SESSION_ENTRIES" --argjson now "$NOW" '
  group_by(.sessionId)
  | map({
      sessionId: .[0].sessionId,
      project: .[0].project,
      count: length,
      lastTs: (max_by(.timestamp) | .timestamp / 1000 | floor),
      age: ($now - (max_by(.timestamp) | .timestamp / 1000 | floor))
    })
  | map(select(.count >= $min_entries and .age >= $min_age))
  | sort_by(.lastTs) | reverse
  | .[:10]
  | .[]
' "$HISTORY_FILE" 2>/dev/null | while read -r session_json; do
  SESSION_ID=$(echo "$session_json" | jq -r '.sessionId')
  PROJECT=$(echo "$session_json" | jq -r '.project')
  COUNT=$(echo "$session_json" | jq -r '.count')
  AGE=$(echo "$session_json" | jq -r '.age')
  AGE_MIN=$((AGE / 60))

  # Skip if already processed
  if grep -q "^${SESSION_ID}$" "$PROCESSED_FILE" 2>/dev/null; then
    echo "  $SESSION_ID: already processed"
    continue
  fi

  # Find session file
  SESSION_FILE=$(find_session_file "$SESSION_ID")
  if [[ -z "$SESSION_FILE" || ! -f "$SESSION_FILE" ]]; then
    echo "  $SESSION_ID: session file not found"
    continue
  fi

  LINE_COUNT=$(wc -l < "$SESSION_FILE" | tr -d ' ')
  PROJECT_SHORT=$(basename "$PROJECT")

  echo "  $SESSION_ID: $LINE_COUNT lines, ${AGE_MIN}m old, $PROJECT_SHORT"

  if try_generate_diary "$SESSION_ID" "$SESSION_FILE" "$LINE_COUNT"; then
    echo "$SESSION_ID" >> "$PROCESSED_FILE"
    echo "  $SESSION_ID: diary generated successfully"
  else
    echo "  $SESSION_ID: failed to generate diary"
  fi

  sleep 2
done

echo "Done."
