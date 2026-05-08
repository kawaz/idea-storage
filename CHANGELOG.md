# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `session convert` subcommand for explicit session × recipe conversion.
- GitHub Actions workflow for CI (replaces the previous local `build-check`).

### Changed

- **Breaking (internal queue API)**: queue schema normalized with foreign keys,
  history, a new `skipped` status, and a `reason` column. Session command code
  has been adapted to the normalized API; callers using the old queue API
  directly need to migrate.
- Queue dequeue is now an `UPDATE` operation, with a new `processing` status,
  plus `claim` / `waitForCompletion` helpers.
- Extracted a pure `processSession` function out of `runProcess` for easier
  testing and reuse.

### Fixed

- `cli`: positional arguments are now documented and `article` sort keys are
  aligned across subcommands.

### Documentation

- Added DR-0006 covering the CI/CD setup with GitHub Actions.

## [0.1.0] - 2026-05-08

First tagged snapshot of the TypeScript/Bun rewrite of idea-storage.

### Added

- TypeScript/Bun CLI replacing the original shell scripts, with `gunshi`-based
  subcommand structure.
- `session` pipeline: enqueue, run, process, with chunked processing fallback
  (retry, unsplit, fail) and per-task timeouts.
- `article` subcommands (`list`, `ls`, `view`) for browsing generated output.
- `service` subcommands (renamed from `launchd`) for managing the background
  worker, including launchd plist with `ExitTimeOut` as a last-resort kill for
  hung processes.
- Rate-limit observation library (parser, store, judge) wired into the worker
  with a skip gate and surfaced via `status` (rate-limit observation and
  worker decision).
- SQLite-backed queue replacing the previous file-based implementation, with
  batched enqueue inside a single transaction.
- Auto-retry of failed tasks with retry count and cooldown.
- Lock file (using `O_EXCL`) to prevent concurrent `session run`.
- Auto-healing for hung worker processes.
- Fork-session detection and timeline trimming for ai-diary generation.
- Append mode for continued sessions.
- `idea-memo`, `ai-diary`, `user-diary` skills and `idea-recorder` agent.
- MIT `LICENSE` and `justfile` for common dev workflows.

### Changed

- Dequeue order is newest-first instead of FIFO (newly enqueued items are
  processed first).
- Default Claude invocation hardened: removed `--dangerously-skip-permissions`
  and defaults `--tools` to the empty set for minimum privilege.
- Simplified `Recipe` type and matcher (removed unused fields).
- Performance: cached queue state with `readdir` to avoid N\*M I/O in enqueue;
  reused `TextEncoder` and pre-split lines in the chunker.
- README and config examples updated to match the current implementation.

### Fixed

- Replaced `process.exit` with `CliError` so locks are released in `finally`
  blocks.
- Various timer / listener / timeout leaks (claude-runner, session-run,
  `spawnWithTimeout`, heartbeat timer unref, CSA subprocess timeouts).
- Increased task timeout to 25 min and CSA timeout to 10 min; skip synthesis
  for single-chunk inputs.
- Skip empty session files (0 lines) early in the processing pipeline.
- Skip broken JSON lines in `session-jsonl` instead of crashing.
- Propagate overall timeout signals to kill running child processes; cancel
  sibling processes on chunked timeout via `AbortController`.
- Validate `HOME` env var, sort keys, and regex patterns in `article`
  commands; input validation for queue key `sessionId` / `recipeName`.
- Use `stat()` instead of `Bun.file()` for directory existence checks.
- Resolved type errors and lint warnings across the codebase (incl. applying
  oxfmt repository-wide).

### Documentation

- Added design records, including DR-0004 (queue persistence design).
- Added a rate-limit-aware scheduling section to the README.

[Unreleased]: https://github.com/kawaz/idea-storage/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kawaz/idea-storage/releases/tag/v0.1.0
