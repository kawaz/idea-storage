#!/usr/bin/env bash
# Extract conversation text from Claude session file
#
# Usage:
#   extract-conversation.sh <session-file-or-id> [max-chars]
#
# Examples:
#   extract-conversation.sh ~/.claude/projects/.../session.jsonl
#   extract-conversation.sh 446f2f8d-ce10-40a1-b7d0-ccc41b83089a
#   extract-conversation.sh 446f2f8d-ce10-40a1-b7d0-ccc41b83089a 10000

set -euo pipefail

CLAUDE_DIR="${HOME}/.claude"
PROJECTS_DIR="${CLAUDE_DIR}/projects"

usage() {
  echo "Usage: $0 <session-file-or-id> [max-chars]"
  exit 1
}

[[ $# -lt 1 ]] && usage

input="$1"
max_chars="${2:-500000}"

# Resolve session file
if [[ -f "$input" ]]; then
  session_file="$input"
  sid=$(basename "$session_file" .jsonl)
else
  # Treat as session ID, find jsonl file
  sid="$input"
  session_file=$(find "$PROJECTS_DIR" -name "${sid}.jsonl" -type f 2>/dev/null | head -1)
  [[ -z "$session_file" ]] && { echo "Session not found: $input" >&2; exit 1; }
fi

# Output session metadata header
session_dir=$(dirname "$session_file")
index_file="${session_dir}/sessions-index.json"
if [[ -f "$index_file" ]]; then
  meta=$(jq -r --arg sid "$sid" '
    .entries[] | select(.sessionId == $sid) |
    "SESSION_ID: " + .sessionId,
    "PROJECT: " + (.projectPath // "unknown"),
    "CREATED: " + ((.created // "") | if . != "" then split(".")[0] + "Z" | fromdateiso8601 | strflocaltime("%Y-%m-%dT%H:%M:%S") else "unknown" end),
    "---"
  ' "$index_file" 2>/dev/null)
  [[ -n "$meta" ]] && echo "$meta"
fi

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
