# idea-storage

A CLI tool that transforms Claude Code session histories into articles using AI recipes.

## Install

```bash
bun install
bun run build
# Copy or symlink dist/idea-storage to a directory in your PATH
```

## Usage

### `session` -- Session processing

```
idea-storage session run               # Scan sessions, enqueue, and process until done
idea-storage session enqueue           # Find matching sessions and add to queue
idea-storage session process           # Process one item from the queue
idea-storage session list              # List all sessions
idea-storage session status            # Show queue status
idea-storage session retry <KEY>       # Re-queue a failed entry
idea-storage session cleanup           # Remove orphaned failed entries
```

### `article` -- Browse generated articles

```
idea-storage article list              # List articles with rich formatting
idea-storage article ls                # List articles (plain output)
idea-storage article view              # Browse articles interactively (fzf + mdp)
```

### `service` -- Manage launchd service (macOS)

```
idea-storage service register          # Install and register the launchd service
idea-storage service unregister        # Unregister the service and remove plist
idea-storage service status            # Show service status
idea-storage service log               # Show service log output
```

### `extract` -- Extract conversation text

```
idea-storage extract <FILE|UUID>       # Extract conversation text from a session
idea-storage extract --max-chars N ... # Truncate from the beginning, keeping recent
```

## Configuration

`~/.config/idea-storage/config.ts` -- TypeScript config (default export):

```typescript
export default {
  claudeDirs: ["~/.claude"], // Directories to scan for session JSONL files
  minAgeMinutes: 120, // Ignore sessions newer than this (default: 120)
};
```

See `config-examples/config.ts` for a full example.

### Recipes

Place `recipe-*.md` files in `~/.config/idea-storage/`. Each recipe uses Markdown with YAML frontmatter for matching rules. See `config-examples/recipe-*.md` for examples.

### Rate-limit-aware scheduling

When run as a launchd service (or any long-running worker), idea-storage observes
your Claude subscription's 5-hour and 7-day rate limits and pauses processing when
your own interactive usage is outpacing elapsed time.

- Rate-limit data is captured transparently from the very `claude` calls the
  worker is already making (via `ANTHROPIC_LOG=debug`) -- no separate probe API
  calls are issued.
- The skip condition is `(util% > 30 || elapsed% > 30) && util% > elapsed% * 0.9`.
  Before the 30% gate is crossed, the worker always runs; past that gate, it only
  runs while usage tracks elapsed time or below.
- On skip, the worker exits cleanly so launchd re-fires at the next `StartInterval`.
- Observations are persisted in the queue SQLite DB (`rate_limits` table) with a
  2-stage retention (24h full resolution, 24h-8d aggregated hourly, 8d+ deleted).
- `idea-storage session status` shows the latest observation and the current
  skip/proceed decision.

See `docs/dr-005-rate-limits-aware-scheduling.md` for the full design.

## Data Paths

All paths follow the XDG Base Directory Specification.

| Path                                 | Purpose                                             |
| ------------------------------------ | --------------------------------------------------- |
| `~/.config/idea-storage/config.ts`   | Configuration                                       |
| `~/.config/idea-storage/recipe-*.md` | Recipe definitions                                  |
| `~/.local/share/idea-storage/`       | Generated articles                                  |
| `~/.local/state/idea-storage/`       | Queue state + rate_limits observations (`queue.db`) |

## Development

```bash
bun test          # Run tests
bun run typecheck # Type check
bun run build     # Build to dist/idea-storage
```

## Requirements

- [Bun](https://bun.sh/)
- [claude](https://docs.anthropic.com/en/docs/claude-cli) CLI
- [claude-session-analysis](https://github.com/kawaz/claude-session-analysis) CLI

## License

MIT
