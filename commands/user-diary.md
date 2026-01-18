---
name: user-diary
description: Generate user activity diary from Claude Code history
argument-hint: "[date|generate|list]"
allowed-tools: ["Bash", "Read", "Write"]
---

# User Diary Command

Generate and manage user activity diaries from Claude Code history.

## Usage

- `/user-diary` or `/user-diary generate` - Generate diary for yesterday
- `/user-diary generate YYYY-MM-DD` - Generate diary for specific date
- `/user-diary list` - List recent diary entries
- `/user-diary read YYYY-MM-DD` - Read specific diary entry

## Implementation

Use the scripts from the user-diary skill:

```bash
# Generate
bash ${CLAUDE_PLUGIN_ROOT}/skills/user-diary/scripts/generate.sh [date]

# List
bash ${CLAUDE_PLUGIN_ROOT}/skills/user-diary/scripts/list.sh -n 7

# Read
bash ${CLAUDE_PLUGIN_ROOT}/skills/user-diary/scripts/read.sh YYYY-MM-DD
```

## Notes

- History file location: `~/.claude/history.json`
- Output location: `~/.local/share/idea-storage/user-diary/YYYY/YYYY-MM-DD.md`
- Requires `jq` for JSON parsing
