# idea-storage

AI-assisted external memory for ideas, plans, and daily reflections.

## Features

### Skills

| Skill | Description |
|-------|-------------|
| **idea-memo** | Save and retrieve ideas, insights, and notes |
| **ai-diary** | AI's candid reflections on sessions (unfiltered) |
| **user-diary** | Activity diary generated from history.json |

### Agent

| Agent | Description |
|-------|-------------|
| **idea-recorder** | Proactively detects and records ideas during conversation |

### Command

| Command | Description |
|---------|-------------|
| `/user-diary` | Generate/list/read user activity diaries |

## Installation

```bash
/plugin marketplace add kawaz/claude-plugins
/plugin install idea-storage@kawaz-claude-plugins
```

## Data Locations

```
~/.local/share/idea-storage/
├── ideas/           # idea-memo data
├── ai-diary/        # AI diary entries
└── user-diary/      # User activity diaries

~/.local/state/idea-storage/
├── processed-sessions.txt  # Tracking for AI diary generation
└── *.log                   # Launchd logs
```

## Session Processor

Process Claude sessions to generate AI diaries:

```bash
# Add eligible sessions to queue
./scripts/idea-storage-session-processor.sh enqueue

# Process one session from queue
./scripts/idea-storage-session-processor.sh process

# Check status
./scripts/idea-storage-session-processor.sh status

# Retry a failed session
./scripts/idea-storage-session-processor.sh retry <session-id>

# Clean up orphaned failed entries
./scripts/idea-storage-session-processor.sh cleanup
```

### How It Works

1. `enqueue` finds sessions matching age/size criteria
2. `process` extracts conversation with `extract-conversation.sh`
3. Pipes conversation to `claude -p` with rule prompt
4. If `output_mode: stdout` in rule, saves result to `data/ai-diary/YYYY/MM/DD/{session-id}.md`

### Extract Conversation Tool

Standalone tool to extract readable conversation from session files:

```bash
# By session ID
./scripts/extract-conversation.sh <session-id>

# By file path
./scripts/extract-conversation.sh ~/.claude/projects/.../session.jsonl

# With character limit
./scripts/extract-conversation.sh <session-id> 100000
```

Output includes: USER, THINKING, ASSISTANT, TOOL_USE, TOOL_RESULT, QUEUED, SUMMARY with timestamps.

### Rule Configuration

Place rules in `~/.config/idea-storage/rule-*.md`:

```yaml
---
match:
  min_lines: 100        # Minimum session lines
  min_age: 7200         # Minimum age in seconds (2 hours)
  # project: "*/work/*" # Optional project path filter
output_mode: stdout     # Save output to file (omit for skill-based saving)
priority: 0             # Higher = preferred when multiple rules match
---
Your prompt here...
```

See `config-examples/` for sample rules.

## Usage Examples

### Idea Memo

Ideas are automatically recorded when the idea-recorder agent detects noteworthy content:
- "Note to self: ..."
- "I just realized..."
- "What if we..."

Or manually search/list:
```bash
# Search ideas
bash ~/.local/share/idea-storage/ideas/../scripts/search.sh "cache"

# List recent ideas
bash ~/.local/share/idea-storage/ideas/../scripts/list.sh -n 5
```

### User Diary

```bash
# Generate yesterday's diary
/user-diary generate

# Generate specific date
/user-diary generate 2026-01-15

# List recent entries
/user-diary list
```

## Requirements

- `jq` for JSON parsing
- `claude` CLI (for AI diary fork feature)

## License

MIT
