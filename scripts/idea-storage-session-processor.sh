#!/usr/bin/env bash
# idea-storage session processor
#
# Usage:
#   idea-storage-session-processor.sh enqueue  # Find sessions and add to queue
#   idea-storage-session-processor.sh process  # Process queue until empty
#   idea-storage-session-processor.sh status   # Show queue status
#   idea-storage-session-processor.sh retry <session-id>  # Retry failed session
#   idea-storage-session-processor.sh cleanup  # Remove orphaned failed entries
#
# Rules: ~/.config/idea-storage/**/rule-*.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
PROJECTS_DIR="${CLAUDE_DIR}/projects"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/idea-storage"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/idea-storage"
QUEUE_DIR="${STATE_DIR}/queue"
DONE_DIR="${STATE_DIR}/done"
FAILED_DIR="${STATE_DIR}/failed"

# Default settings
MIN_AGE_MINUTES=120    # 2 hours
MAX_AGE_MINUTES=10080  # 7 days

[[ -f "${CONFIG_DIR}/config.sh" ]] && source "${CONFIG_DIR}/config.sh"

mkdir -p "$QUEUE_DIR" "$DONE_DIR" "$FAILED_DIR"

# === Helpers ===

# Get file mtime in seconds since epoch (cross-platform)
get_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0
}

parse_frontmatter() {
  local file="$1" key="$2" default="${3:-}"
  local in_fm=false value=""
  while IFS= read -r line; do
    [[ "$line" == "---" ]] && { $in_fm && break || { in_fm=true; continue; }; }
    if $in_fm; then
      if [[ "$key" == *"."* ]]; then
        local child="${key#*.}"
        [[ "$line" =~ ^[[:space:]]+${child}:[[:space:]]*([^#]+) ]] && {
          value="${BASH_REMATCH[1]%"${BASH_REMATCH[1]##*[![:space:]]}"}"
          value="${value#\"}" ; value="${value%\"}"
          break
        }
      else
        [[ "$line" =~ ^${key}:[[:space:]]*([^#]+) ]] && {
          value="${BASH_REMATCH[1]%"${BASH_REMATCH[1]##*[![:space:]]}"}"
          value="${value#\"}" ; value="${value%\"}"
          break
        }
      fi
    fi
  done < "$file"
  echo "${value:-$default}"
}

get_prompt_content() {
  local file="$1" in_fm=false after_fm=false
  while IFS= read -r line; do
    [[ "$line" == "---" ]] && { $in_fm && { after_fm=true; continue; } || { in_fm=true; continue; }; }
    $after_fm && echo "$line"
    ! $in_fm && echo "$line"
  done < "$file"
}

find_matching_rule() {
  local project="$1" line_count="$2" age_sec="$3" has_end="$4" skip_max_age="${5:-false}"
  local best="" best_pri=-999999

  while IFS= read -r -d '' f; do
    local pri=$(parse_frontmatter "$f" "priority" "0")
    local mp=$(parse_frontmatter "$f" "match.project" "")
    local min_l=$(parse_frontmatter "$f" "match.min_lines" "0")
    local max_l=$(parse_frontmatter "$f" "match.max_lines" "999999")
    local min_a=$(parse_frontmatter "$f" "match.min_age" "0")        # seconds
    local max_a=$(parse_frontmatter "$f" "match.max_age" "999999999") # seconds
    local req_end=$(parse_frontmatter "$f" "match.require_session_end" "false")

    [[ -n "$mp" ]] && [[ "$project" != $mp ]] && continue
    [[ "$line_count" -lt "$min_l" || "$line_count" -gt "$max_l" ]] && continue
    # min_age: always check, max_age: skip when processing queued items
    [[ "$age_sec" -lt "$min_a" ]] && continue
    [[ "$skip_max_age" != "true" && "$age_sec" -gt "$max_a" ]] && continue
    [[ "$req_end" == "true" && "$has_end" != "true" ]] && continue

    [[ "$pri" -gt "$best_pri" ]] && { best_pri="$pri"; best="$f"; }
  done < <(find "$CONFIG_DIR" -name 'rule-*.md' -type f -print0 2>/dev/null)
  echo "$best"
}

# $1: session_id, $2: rule_name
get_done_lines() {
  local done_file="${DONE_DIR}/${1}.${2}"
  [[ -f "$done_file" ]] && cat "$done_file" || echo ""
}

# $1: session_id, $2: rule_name, $3: line_count
mark_done() {
  echo "$3" > "${DONE_DIR}/${1}.${2}"
}

# Extract conversation text from session file (tail priority)
extract_conversation() {
  local session_file="$1" max_chars="${2:-500000}"
  jq -r '
    # Convert timestamp to local time (ISO-like format)
    def localtime: (split(".")[0] + "Z" | fromdateiso8601 | strflocaltime("%Y-%m-%dT%H:%M:%S"));

    (.timestamp // "" | if . != "" then "[" + localtime + "] " else "" end) as $ts |

    if .type == "user" then
      if .message.content | type == "array" then
        .message.content[] |
        if .type == "text" then
          $ts + "USER: " + .text
        elif .type == "tool_result" then
          $ts + "TOOL_RESULT: " + (
            if .content | type == "array" then
              [.content[] | select(.type == "text") | .text] | join("")
            else
              .content // ""
            end
          )
        else
          empty
        end
      else
        $ts + "USER: " + (.message.content // "")
      end
    elif .type == "assistant" then
      if .message.content | type == "array" then
        .message.content[] |
        if .type == "thinking" then
          $ts + "THINKING: " + .thinking
        elif .type == "text" then
          $ts + "ASSISTANT: " + .text
        elif .type == "tool_use" then
          $ts + "TOOL_USE: " + .name + (if .input then " " + (.input | tostring | .[0:100]) else "" end)
        else
          empty
        end
      else
        empty
      end
    elif .type == "summary" then
      $ts + "SUMMARY: " + .summary
    elif .type == "queue-operation" then
      if .operation == "enqueue" and .content then
        $ts + "QUEUED: " + .content
      else
        empty
      end
    else
      empty
    end
  ' "$session_file" | tail -c "$max_chars"
}

# === ENQUEUE ===
cmd_enqueue() {
  local count=0
  # Find UUID-named session files within age range
  # UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  find "$PROJECTS_DIR" -type f -name '????????-????-????-????-????????????.jsonl' \
    -mmin +${MIN_AGE_MINUTES} -mmin -${MAX_AGE_MINUTES} 2>/dev/null | while read -r f; do
    local sid=$(basename "$f" .jsonl)
    local line_count=$(wc -l < "$f" | tr -d ' ')
    local file_age_sec=$(($(date +%s) - $(get_mtime "$f")))
    local has_end="false"
    tail -20 "$f" 2>/dev/null | grep -q '"type":"summary"' && has_end="true"

    # Get project path
    local session_dir=$(dirname "$f")
    local project=$(jq -r --arg sid "$sid" '.entries[] | select(.sessionId == $sid) | .projectPath // empty' "${session_dir}/sessions-index.json" 2>/dev/null)

    # Check each rule
    while IFS= read -r -d '' rule_file; do
      local rule_name=$(basename "$rule_file" .md)
      rule_name="${rule_name#rule-}"
      local qkey="${sid}.${rule_name}"

      # Skip if already queued or failed
      [[ -f "${QUEUE_DIR}/${qkey}" ]] && continue
      [[ -f "${FAILED_DIR}/${qkey}" ]] && continue

      # Check if rule matches (with max_age check for enqueue)
      local pri=$(parse_frontmatter "$rule_file" "priority" "0")
      local mp=$(parse_frontmatter "$rule_file" "match.project" "")
      local min_l=$(parse_frontmatter "$rule_file" "match.min_lines" "0")
      local max_l=$(parse_frontmatter "$rule_file" "match.max_lines" "999999")
      local min_a=$(parse_frontmatter "$rule_file" "match.min_age" "0")
      local max_a=$(parse_frontmatter "$rule_file" "match.max_age" "999999999")
      local req_end=$(parse_frontmatter "$rule_file" "match.require_session_end" "false")

      [[ -n "$mp" ]] && [[ "$project" != $mp ]] && continue
      [[ "$line_count" -lt "$min_l" || "$line_count" -gt "$max_l" ]] && continue
      [[ "$file_age_sec" -lt "$min_a" || "$file_age_sec" -gt "$max_a" ]] && continue
      [[ "$req_end" == "true" && "$has_end" != "true" ]] && continue

      # Skip if already processed with same line count
      local done_lines=$(get_done_lines "$sid" "$rule_name")
      [[ -n "$done_lines" && "$line_count" -le "$done_lines" ]] && continue

      touch "${QUEUE_DIR}/${qkey}"
      echo "Queued: $qkey"
      ((count++)) || true
    done < <(find "$CONFIG_DIR" -name 'rule-*.md' -type f -print0 2>/dev/null)
  done
  echo "Done"
}

# === PROCESS ===
cmd_process() {
  local oldest=$(ls -tr "$QUEUE_DIR" 2>/dev/null | head -1)
  [[ -z "$oldest" ]] && { echo "Queue empty"; exit 1; }

  # Parse queue key: {sessionid}.{rulename}
  local qkey="$oldest"
  local qfile="${QUEUE_DIR}/${qkey}"
  local sid="${qkey%.*}"           # everything before last dot
  local rule_name="${qkey##*.}"    # everything after last dot

  local session_file=$(find "$PROJECTS_DIR" -name "${sid}.jsonl" -type f 2>/dev/null | head -1)

  if [[ -z "$session_file" || ! -f "$session_file" ]]; then
    echo "$qkey: session file not found"
    rm -f "$qfile"
    exit 0
  fi

  # Find the rule file
  local rule="${CONFIG_DIR}/rule-${rule_name}.md"
  if [[ ! -f "$rule" ]]; then
    echo "$qkey: rule file not found"
    rm -f "$qfile"
    exit 0
  fi

  local line_count=$(wc -l < "$session_file" | tr -d ' ')

  # Get session info from sessions-index.json
  local session_dir=$(dirname "$session_file")
  local session_info=$(jq -r --arg sid "$sid" '.entries[] | select(.sessionId == $sid)' "${session_dir}/sessions-index.json" 2>/dev/null)
  local project=$(echo "$session_info" | jq -r '.projectPath // empty')
  local session_created=$(echo "$session_info" | jq -r '.created // empty')

  local prompt=$(get_prompt_content "$rule")
  local on_existing=$(parse_frontmatter "$rule" "on_existing" "append")

  local done_lines=$(get_done_lines "$sid" "$rule_name")
  local mode="new"

  if [[ -n "$done_lines" ]]; then
    if [[ "$line_count" -le "$done_lines" ]]; then
      echo "$qkey: no new activity"
      rm -f "$qfile"
      exit 0
    fi
    case "$on_existing" in
      skip) echo "$qkey: skipping"; rm -f "$qfile"; exit 0 ;;
      separate) mode="new" ;;
      *) mode="append"; prompt="$prompt

---
Note: Session continued. Please append to existing entry." ;;
    esac
  fi

  echo "$qkey: [$rule_name] $mode ($line_count lines) @ ${project:-unknown}"

  # Extract conversation (tail priority, max 500KB)
  local conversation
  conversation=$(extract_conversation "$session_file" 500000)

  # Build full prompt with session context
  local full_prompt="${prompt}

---
## セッション情報
- Session ID: $sid
- Project: ${project:-unknown}
- Created: ${session_created:-unknown}

## 会話ログ
$conversation"

  # Run from idea-storage directory
  local data_dir="${XDG_DATA_HOME:-$HOME/.local/share}/idea-storage"
  local log_file="${FAILED_DIR}/${qkey}.log"

  # Always save stdout to file: {rule_name}/{YYYY/MM/DD}/{sid}.md
  local created_date="${session_created%%T*}"  # YYYY-MM-DD
  [[ -z "$created_date" ]] && created_date=$(date +%Y-%m-%d)
  local output_dir="${data_dir}/${rule_name}/${created_date//-//}"  # {rule_name}/YYYY/MM/DD
  mkdir -p "$output_dir"
  local output_file="${output_dir}/${sid}.md"

  if (cd "${SCRIPT_DIR}/.." && \
      SESSION_ID="$sid" SESSION_TS="$session_created" claude \
        -p "$full_prompt" \
        --no-session-persistence \
        --dangerously-skip-permissions \
        --add-dir "$data_dir" \
      2>&1 | tee "$output_file" "$log_file"); then
    rm -f "$log_file"  # Success: remove log
    mark_done "$sid" "$rule_name" "$line_count"
    rm -f "$qfile"
    echo "$qkey: success -> $output_file"
  else
    mv "$qfile" "${FAILED_DIR}/${qkey}"
    echo "$qkey: failed (see $log_file)"
  fi
}

# === STATUS ===
cmd_status() {
  local queue_count=$(ls "$QUEUE_DIR" 2>/dev/null | wc -l | tr -d ' ')
  local done_count=$(ls "$DONE_DIR" 2>/dev/null | wc -l | tr -d ' ')
  local failed_count=$(ls "$FAILED_DIR" 2>/dev/null | grep -cv '\.log$' 2>/dev/null || echo 0)
  echo "Queue: $queue_count | Done: $done_count | Failed: $failed_count"
  ls -ltr "$QUEUE_DIR" 2>/dev/null | tail -10
}

# === RETRY ===
cmd_retry() {
  local qkey="${1:-}"
  [[ -z "$qkey" ]] && { echo "Usage: $0 retry <session-id.rule-name>"; exit 1; }
  [[ ! -f "${FAILED_DIR}/${qkey}" ]] && { echo "Not in failed: $qkey"; exit 1; }
  mv "${FAILED_DIR}/${qkey}" "${QUEUE_DIR}/${qkey}"
  rm -f "${FAILED_DIR}/${qkey}.log"
  echo "Moved to queue: $qkey"
}

# === CLEANUP ===
cmd_cleanup() {
  local count=0
  for f in "$FAILED_DIR"/*; do
    [[ ! -f "$f" ]] && continue
    local qkey=$(basename "$f")
    [[ "$qkey" == *.log ]] && continue
    local sid="${qkey%.*}"  # extract session id
    local session_file
    session_file=$(find "$PROJECTS_DIR" -name "${sid}.jsonl" -type f 2>/dev/null | head -1)
    [[ -z "$session_file" ]] && {
      rm -f "${FAILED_DIR}/${qkey}" "${FAILED_DIR}/${qkey}.log"
      echo "Removed (no session file): $qkey"
      ((count++)) || true
    }
  done
  echo "Cleaned up $count entries"
}

# === MAIN ===
case "${1:-}" in
  enqueue) cmd_enqueue ;;
  process) cmd_process ;;
  status)  cmd_status ;;
  retry)   cmd_retry "${2:-}" ;;
  cleanup) cmd_cleanup ;;
  *) echo "Usage: $0 {enqueue|process|status|retry|cleanup}"; exit 1 ;;
esac
