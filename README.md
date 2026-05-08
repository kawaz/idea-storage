# idea-storage

A CLI tool that transforms Claude Code session histories into articles using AI recipes.

## Why this exists

A long Claude Code session leaves behind a huge JSONL transcript. A week later, you ask
yourself: _"What did I actually decide on Monday? What's still pending? What did I learn
that I want to reuse next time?"_ — and you end up scrolling through hours of transcript
to reconstruct your own work.

idea-storage runs in the background and rewrites each finished session through a set of
recipes. One recipe extracts an actionable TODO list, another writes a quiet diary of
what the agent felt during the session, another distills reusable knowledge. The cost of
looking back drops from "re-read the whole session" to "skim a 1-page article from the
angle I care about right now."

### Example use cases

- **"What did I work on last week?"** → `summary` recipe gives you a per-section digest.
- **"What did I leave unfinished?"** → `todo` recipe groups Next Action / Backlog /
  Blocked / Questions.
- **"How did this project actually evolve?"** → `diary` recipe reconstructs the felt
  experience and turning points.
- **"What did I learn that I want to reuse?"** → `knowledge` recipe captures TILs and
  reusable patterns.

## Sample output

All snippets below are real excerpts from a single ~2.5 hour session that built a
healthcheck agent from scratch (`session 64bac255…`). Each recipe was applied to the
same transcript.

**`todo`** — Next Action / Backlog / Blocked / Questions, ready to resume from:

> ### Next Action — すぐやること
>
> 1. **キャッシュ方針の決定と組み込み** ← このチャンク末尾でユーザーから新たに出た要求
>    - 直前の合意では「キャッシュは削る」だったが、ユーザーが**負荷観点で復活させても良い**と言い直した。スコープに再投入する必要がある
>    - 決めるべきこと: キャッシュキー / TTL / 実装方式 / 対象範囲

**`summary`** — concise per-section digest:

> **一言まとめ**: Go で `/proc` 直読み型のポート監視 HTTP エージェント `port-peeker` を MVP 実装し、実機 (linux/arm64, AL2023) で全パターン動作確認まで完了。
>
> **結果・成果**: Phase 1 MVP 完了 — 外部コマンド依存ゼロ・cgo オフでクロスビルド可・全テスト race detector 通過。

**`diary`** — first-person reflection on what the session felt like:

> 設計書という「権威」を削るのは、ユーザの意図を読み間違えると失礼になる。でも残しすぎるとそれもまた違う。`/check` と `/healthz` だけに絞り、metrics・キャッシュ・proto・unit・loose・構造化ログ・systemd unit ファイルを「全部削る」と宣言したとき、内心ちょっとドキドキしていた。やりすぎかなと。
>
> 結果としてユーザの返事は「むしろ設計書がゴテゴテしすぎ、で十分と思う」。ホッとした。

**`knowledge`** — reusable TILs and patterns extracted from the work:

> ### `! cmd | grep -q . || fallback` パターン
>
> justfile のように「各行が独立・失敗で中断」な環境で「出力があれば処理、なければスキップして続行」を実現する定型句。`|| true` と違い、fallback 側の失敗は正しく伝播する。

Other built-in-style recipes include `changelog`, `letter`, `report-for-boss`, `roast`,
`blame`, and `story`. You write your own as plain Markdown.

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
idea-storage session convert \
    --session <id> --recipe <name>     # Convert a specific (session, recipe) pair directly
idea-storage session list              # List all sessions
idea-storage session status            # Show queue status
idea-storage session retry <KEY>       # Re-queue a failed entry
idea-storage session cleanup           # Remove orphaned failed entries
```

`session convert` runs a specific session/recipe pair directly, bypassing queue order
(useful for re-running a single recipe or testing a new one). If the queue worker is
already processing, it waits for completion before running.

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

See `docs/decisions/DR-0005-rate-limits-aware-scheduling.md` for the full design.

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
