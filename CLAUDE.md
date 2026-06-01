# CLAUDE.md (= 新しいセッション向けプロジェクト案内)

このファイルは Claude / AI agent が idea-storage リポで作業を始めるときに最初に読む onboarding。プロジェクトの全体像 + 守るべき規約 + よく使うコマンド + 参照先を 1 枚にまとめる。

## このプロジェクトは何

`idea-storage` は **Claude Code セッション JSONL を AI recipe で「読み返せる
記事」に変換する CLI**。

- セッション毎の JSONL を **CSA** (`claude-session-analysis`) で timeline 化
- recipe (= prompt + frontmatter + match 条件) を当てて claude CLI で生成
- `dispatcher` recipe が「セッションに対してどの recipe を当てるか」を LLM 判定
- `quality_gate` recipe が生成物を二値判定、不採用は `_rejected/` に退避
- queue (queue.db, SQLite) で recipe 適用を非同期スケジュール、worker が dequeue

詳細・経緯は `README.md` + `docs/decisions/INDEX.md` (DR 一覧)。

## アーキ要点

```
commands/        — CLI エントリ (session-{process,convert,enqueue,run,status,...})
lib/             — ドメインロジック
  redact.ts             secret パターン primitive
  redact-pipeline.ts    用途別 redact (log/output/prompt) 高レベル層
  spawn-env.ts          subprocess env allowlist (CSA 用)
  queue-internal.ts     queue.db open + applyMigrations (v2)
  queue-schema.ts       schema migration (v0→v1→v2)
  queue.ts              queue write API (enqueue / claim / markDone ...)
  queue-state.ts        queue read API (status / loadQueueState ...)
  rate-limit-store.ts   rate_limits 永続化 (queue.db 同居、queue-internal の wrapper)
  conversation.ts       CSA sessions / meta / timeline
  recipe.ts             recipe loading / matching
  dispatcher.ts         dispatcher recipe (= recipe 採否を LLM に判定)
  quality-gate.ts       quality_gate recipe (= 生成物の採否)
  recent-outputs.ts     §9 過去出力注入 (繰り返し回避)
  frontmatter.ts        YAML scalar safe encode + parse
  logging.ts            redact + size cap した structured log
  ...
docs/
  decisions/    DR-NNNN-... (設計判断記録)、INDEX.md で一覧
  journal/      日付別の作業ジャーナル
  issue/        ローカル issue (= GH Issues 不使用、本リポは file 起票運用)
  runbooks/     運用フェーズで再発する手順
  findings/     単発調査の確定事実
src/types/      共通型 (一部は lib に colocate 移行中)
```

外部依存:

- **CSA** (`claude-session-analysis`): セッション timeline / meta / stats を出す CLI
- **claude CLI**: recipe 適用 / dispatcher / quality_gate の LLM 呼び出し
- **bun**: ランタイム + テストランナー + パッケージマネージャ

## よく使うコマンド

`justfile` に集約:

```bash
just build         # bun run scripts/build.ts (バイナリ化)
just test          # bun test
just typecheck     # bunx tsc --noEmit
just lint          # bunx oxlint
just fmt           # bunx oxfmt (= 書き換え)
just fmt-check     # bunx oxfmt --check
just check         # test + typecheck + lint + fmt-check
just push          # check 経由で jj git push
```

完了条件 (= main に出す前の起点 / 完了確認):

```bash
bun test            # default test
bunx tsc --noEmit   # 型チェック
bun test --isolate  # test 間の state 漏れチェック
```

## 規約

### バージョン管理: jj 管理

`.claude/rules/version-control.md` に書いてある通り、本リポは jj (Jujutsu)
管理。詳細は `~/.claude/rules/` 経由のグローバル jj-workflow rule を参照
(kawaz の personal rule)。

### push: `just push` を使う

`just push` 経由で品質ゲート (test + typecheck + lint + fmt-check) を通してから
push。直接 `jj git push` を叩かない (= push-guard で誘導される)。push 後は CI を
watch (gh-monitor 経由が標準)。

### Issue は `docs/issue/` でローカル起票

本リポは GitHub Issues を使わない。未解決トピックは `docs/issue/<file>.md` で
ローカル起票し、解決時に削除 (削除前に設計判断は `docs/decisions/`、運用手順は
`docs/runbooks/`、経緯は `docs/journal/` に必要に応じて転記)。

### 設計判断は DR で残す

複数選択肢から 1 つを選んだ、コストを上回る設計上の優位性で方針を決めた、過去の
決定を覆す、等の判断は `docs/decisions/DR-NNNN-...md` に記録。
`docs/decisions/INDEX.md` で一覧管理。

### Phase 進行 (DR-0009)

進行中のリファクタリング roadmap は `docs/decisions/DR-0009-architecture-refactor-roadmap.md`。

- Phase 1 (P0 security): 完了 (= redact pipeline / chmod 0600 / YAML escape)
- Phase 2 (DB 単一化): 完了 (= rate_limits を queue-schema v2 に統合)
- Phase 3+4+5 (本命解体 + test 分割 + lib/ subdir): 未着手
- Phase 6 (DR 整合): 未着手 (DR-0008 §6 amend vs 拡張は kawaz 判断)
- Phase 7 (横断細部): 部分着手 (= redact pattern 拡充済)
- Phase 8 (運用整備): 部分着手 (= 本 CLAUDE.md)

### セキュリティ姿勢

DR-0009 Phase 1 で構築:

- **redact pipeline**: `lib/redact-pipeline.ts` の意図別関数 (redactForLog /
  redactForOutput / redactForPrompt) で各経路を保護。raw `redactSecrets()`
  直叩きより call site の意図が明確。
- **多層防御**: timeline 入力 / Bun.write 直前 / quality-gate / dispatcher /
  recent-outputs / chunked synthesis / logger 全層で idempotent な redact。
- **chmod 0600 / mode 0700**: output / `_rejected/` / queue.db / WAL/SHM すべて
  owner-only。新規分のみ (= 既存ファイル遡及は migration コスト避けて捨て、
  攻撃面縮小は新規書き込みからで十分とする判断)。
- **CSA spawn env allowlist**: `lib/spawn-env.ts` の `buildCsaEnv()` で
  ANTHROPIC_API_KEY / GH_TOKEN / SSH_AUTH_SOCK 等を CSA に渡さない。claude CLI
  spawn は ANTHROPIC_API_KEY 必須なので env 全送のまま。

### テスト姿勢

- 「テストを通すが目的化」禁則: flake する固定 sleep / 並列タイミング依存テストは
  shouldn't exist
- mock は外部 API のみ。CSA は mock 不許可 (= 実 CSA を tempDir + fixture jsonl
  で呼ぶ、`src/lib/test-fixtures.ts` 参照)。claude CLI のみ mock 可、現状の
  4 箇所 mock.module は DR-0009 Phase 3 で `_runClaude` DI 経由に撤去予定
- TDD (t_wada): 新規 API はテスト先行
- 完了条件: 3 種 (`bun test` / `bunx tsc --noEmit` / `bun test --isolate`) 全 pass

## 関連

- `README.md`: ユーザ向け概要 / 使い方 / sample output
- `docs/decisions/INDEX.md`: DR 一覧
- `docs/decisions/DR-0009-architecture-refactor-roadmap.md`: 進行中 roadmap
- `docs/journal/`: 日付別作業記録 (= 経緯を後で復元する起点)
