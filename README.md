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

## Launchd Setup (Optional)

For automatic diary generation:

```bash
bash ~/.local/share/idea-storage/scripts/install-launchd.sh
```

This installs:
- **User diary**: Generated daily at 00:30 from history.json
- **AI diary**: Checked hourly, generates from ended sessions by forking them

### How AI Diary Works

1. Every hour, `generate-ai-diary.sh` checks recent sessions
2. If a session has ended (no activity for 30min) and has substantial content
3. It forks the session with `claude --resume` and asks Claude to write a diary
4. The diary is written from that session's context, capturing honest reflections

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
