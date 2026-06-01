# 2026-06-01: ゼロベース全体レビュー結果 (4 agent 並列)

## 達成

DR-0008 完了後、ユーザ指示「差分修正の場当たり」を脱して**ゼロベースで全体を徹底レビュー**。4 並列 agent (設計責務分離 / テスト品質 / アーキ・DR 整合 / セキュリティ) を投入し、構造の根幹問題・脆弱性・縮小実装・テスト責務肥大を網羅的に特定。

リファクタリングロードマップは `docs/decisions/DR-0009-architecture-refactor-roadmap.md` に集約。本 journal は **4 agent の発見の凝縮**を残し、新セッションが「DR-0009 + 本 journal」の 2 ファイルでロードマップ全体を把握できる起点とする。

## 4 agent の主要発見 (凝縮)

### Agent A: 設計責務分離

**最重要**:

1. `commands/session-process.ts` (889 行) が CLI コマンドではなく **アプリの中核オーケストレーション層**。`processSession` (240 行の一枚岩、10 責務)、`processChunked`、`runProcess`、`runDispatcherEntry`、`fetchSessionStats` 等を全部抱え込み、`commands/session-convert.ts` → `commands/session-process.ts` の **command → command 逆方向 import** が発生
2. **CSA ドメインが 2 ファイルに分裂**: `conversation.ts` (`runCsaSessions`, `getSessionMeta(Batch)`) と `session-process.ts` (`csaBin` 再定義、`csa timeline` spawn、`fetchSessionStats`、`isValidCsaTimeline`) — `csaBin` が両ファイルで重複定義
3. **LLM DI シーム 3 種混在**:
   - `dispatcher`: `_runClaude(prompt: string)`
   - `quality-gate`: `_runClaude(prompt: string)`
   - `processChunked`: `_runClaudeOverride(options: ClaudeRunOptions)` (型も名前も違う)
   - `processSession`: **DI 経路が無い**
4. **`run*` 命名の意味多重化**: `runProcess` / `runEnqueue` / `runConvert` (driver) と `runDispatcher` / `runQualityGate` (LLM ワーカー) が同 prefix
5. `validate.ts` と `queue-internal.ts` に **同名関数 `validateSessionId` / `validateRecipeName`** が CLI 用 tight / 内部 loose で 2 種 → IDE 補完で区別不能

**解体プラン提案**:

```
lib/
  csa.ts                     # CSA 接合一切
  session-worker/
    index.ts                 # processSession を ~40 行のオーケストレータに
    prompt-builder.ts
    fork-timeline.ts
    chunked-runner.ts
    frontmatter-builder.ts
    persistence.ts
  driver/
    process-driver.ts        # runProcess
    convert-driver.ts        # runConvert
    enqueue-driver.ts        # runEnqueue
    dispatcher-entry.ts      # processDispatcherEntry (旧 runDispatcherEntry)
  recipe.ts                  # findRecipeByName + loadRecipesOrFail + matchesRecipe 統合
commands/
  session-*.ts               # 全部 define() ラッパー ~30 行に縮退
```

命名再編: `runDispatcher` → `decideDispatch`、`runQualityGate` → `judgeQuality`、`runDispatcherEntry` → `processDispatcherEntry`。

### Agent B: テスト全体の質

**最重要**:

1. `processSession` に `_runClaude` DI 経路が無い → テスト側は `mock.module("../lib/claude-runner.ts")` を選ばざるをえない (production の DI 設計欠落がテストの mock 化を強制)
2. `session-process.test.ts` (1240 行) に **12 個の describe が同居** (run-process / build\*Prompt / processChunked / fork guard / redact 統合 / timeline validation / etc.)
3. `queue.test.ts` (1205 行) は **queue + queue-state + queue-schema + queue-internal の 4 モジュール責務**を抱え込んでる (`queue-state.test.ts` / `queue-schema.test.ts` は存在しない)
4. **`createSessionFile` が 3 ファイルで bespoke 重複** (session-process / session-convert / session-enqueue)、`writeSessionFixture` ヘルパは `conversation.test.ts` でしか使われてない
5. `src/types/index.test.ts` 104 行は **型注釈の runtime 確認だけ** (TypeScript が先に弾くので signal ゼロ)
6. **緩い assertion**: `runClaudeCalls.length >= 1` 等、deterministic に書けるはずなのに `toBeGreaterThanOrEqual` を使ってる箇所
7. **欠落カバレッジ**: `runDispatcherEntry` の dequeue 経由 e2e / `quality_gate rejected → _rejected/` の filesystem 検証 / `fetchSessionStats` (CSA spawn ラッパ) / `recordWorkerObservation` の DB 失敗 swallow path

**mock 完全撤去戦略**: 残ってる 4 箇所すべて processSession 系。`_runClaude` DI を貫通させれば全部 inline override で代替可能。書き換え量は production 30 行 + test 60 行、**正味 LOC は減少**。

### Agent C: アーキテクチャ・DR 整合性

**最重要**:

1. **1 DB ファイル × 2 schema 管理者**: `queue-internal.ts:100 getDb()` → `applyMigrations()` (sessions/recipes/queue_entries/history を `user_version` 管理) と `rate-limit-store.ts:53 getDb()` → `initSchema()` (`rate_limits` を **version 管理外** で `CREATE IF NOT EXISTS`) が並立。同じ DB に 2 つの schema 管理者
2. **全 queue 関数で `db.close()` の都度 open**: ループのたびに `applyMigrations` 再実行 (= `PRAGMA user_version` チェック走る)
3. **`QueueDirs` 型は dead-shaped abstraction**: SQLite 化以降 `resolveDbPath()` で dirname 1 個に圧縮されるだけ、全 queue 関数に残ってるのは古い fixture との互換のため
4. **`@deprecated` paths 3 関数** (`getQueueDir` / `getDoneDir` / `getFailedDir`) が `migrate-queue.ts` で現役利用
5. DR-0008 §6 dispatcher 入力スキーマが **縮小実装**: DR は `turn_classification` (4 カウント) / `size_bytes` / `duration_ms` を入力に含めると規定しているが、`SessionMeta` 自体がそれらを保持してない → dispatcher prompt には `user_turns` / `effective_user_turns` / `line_count` / `forked_from` のみ
6. DR-0008 §11 観測指標が**部分実装**: 「last 30 days 窓」「dispatcher fallback rate」「quality gate rejection rate」「effective filter pass rate」が未実装、現状は lifetime totals のみ
7. types/index.ts の集約方針が不徹底: 一部は集約 (`Recipe` `SessionMeta` `QueueEntry` `Config` `ConversationMessage`)、一部は colocate (`TimelineChunk` `ClaudeRunOptions` `QueueStatus` `RateLimitObservation` `SkippedMeta`) で **方針が一貫しない**

**lib/ 副ディレクトリ化案** (DR-0009 Phase 5 参照): queue/ rate-limit/ csa/ claude/ recipe/ article/ service/ session-worker/ driver/ + 横断 (errors / logging / paths / config / constants / help / validate / format / dir-exists / lockfile / spawn-timeout / timeout-error / chunker / frontmatter / redact)

### Agent D: セキュリティ

**構造的に堅い箇所 (保持すべき設計)**:

- 全 `Bun.spawn` が配列形式 → **シェルインジェクション構造的に不可**
- session_id を UUID 正規表現で厳格 validate → **argv injection (`--flag` 化) も不可**
- 全 41 箇所の SQL クエリが `?` parameter binding 徹底 → **SQL injection ゼロ**
- claude CLI に `--tools ""` + `--no-session-persistence` (LLM 副作用最小化)
- CI workflow が `contents: read` 最小権限
- lockfile が write-then-link で TOCTOU 意識

**重大セキュリティ問題 top 5**:

1. **S1 (高)**: `logging.ts:sanitizeLogPayload` は `error` キーのみ `redactSecrets` 適用 → `logError({ stderr: csaResult.stderr })` や dispatcher の `raw_excerpt: raw.slice(0, 500)` が **無加工素通り** → CSA stderr / LLM 出力片に含まれる secrets がログ経路で漏れる
2. **S2 (高)**: timeline は redact されるが、`processSession` の生成 `output` → `Bun.write(outputFile)` / `runQualityGate` 入力 / `recent-outputs` の prompt 先頭注入 / dispatcher `raw_excerpt` (history.message) → **すべて未 redact**。「by extension で出力もカバー」のコメントは実装で担保されていない仮定。**3 経路に増幅**
3. **S3 (中-高)**: `Bun.write` / `Database` が mode 指定なし → デフォルト 0644 (world-readable)。マルチユーザ host で session 要約 / queue.db / rate_limit 履歴 / `_rejected/` 内容が他ユーザに読まれる
4. **S4 (中)**: CI で CSA を `git clone --depth 1` で **SHA pin なし**、3rd-party action も major tag (`@v2/@v4/@v3`) で **SHA pin なし** → CSA リポ乗っ取りで CI 任意コード実行
5. **S5 (中)**: `config.ts` の `await import(configPath)` で **任意 TS が実行される** (executable config)。XDG_CONFIG_HOME 経路を攻撃可能なら即 RCE。設計上のフットガン

**細部**:

- `frontmatter.ts:generateFrontmatter` が値を `String(value)` で YAML 直書き → session の cwd 経由で `\n---\n` 注入で frontmatter 構造破壊
- CSA spawn に `{...process.env}` 全部渡してる → `ANTHROPIC_API_KEY` / 1Password sock / GITHUB_TOKEN 不要なのに渡してる、**最小権限の逸脱**
- redact pattern 拡充の余地: Slack token (`xox[abpr]-...`) / Stripe `sk_live_` / GCP service account key / OpenAI 新形式 `sk-proj-` `sk-svcacct-` / generic env (`(API_)?KEY|SECRET|PASSWORD|TOKEN`)
- `session-jsonl.ts` の 1 行サイズ上限なし → 悪意ある 100MB 行で OOM

## 全 agent が一致する根幹問題

**`commands/session-process.ts` (889 行) の解体** が:

- Agent A の DI シーム統一 / CSA ドメイン集約 / `run*` 命名再編
- Agent B の mock.module 4 箇所完全撤去 / session-process.test.ts 6 分割
- Agent C の commands→commands 逆方向結合解消
- Agent D の output / quality-gate / inject 経路 redact 欠落 (新生 `persistence` モジュールで集約)

**を同時に解消する**。これが DR-0009 Phase 3 の根拠。

## 不採用判断の記録

- **「現状でも動いてる」を理由に見送り**: ユーザの「セキュリティとか細かい修正をレビューできるレベルに至ってすらなく無い?」「テストを通すが目的化してはいけない」の趣旨に真っ向反する。S1〜S3 を放置するのは論外
- **全部一気に大改造**: PR が巨大化、レビュー / 切り戻しが困難。フェーズ分割が筋
- **commands/ を維持したまま処理を lib/ に移すだけ**: 命名 (`run*` 二重化など) と責務境界の問題が残る。命名再編まで通すのが筋
- **Phase 1 (security) を Phase 3 (本命解体) と統合**: Phase 1 は Phase 3 と独立に動けて、セキュリティ閉じが先になる方が安全。並行が筋

## 引き継ぎ

- ロードマップ: `docs/decisions/DR-0009-architecture-refactor-roadmap.md`
- 各 Phase の詳細設計・粒度確定・実装は **個別の新セッション** で詰める
- 新セッション開始時の起点: 本 journal + DR-0009 + `bun test` / `bunx tsc --noEmit` が pass している状態

## 関連

- DR-0008 (実装完了、本ロードマップの起点)
- DR-0009 (本 journal をもとに作成したロードマップ DR)
- 過去 journal 2026-05-30-pr1〜pr6, 2026-05-31-mock-removal-\* (DR-0008 各 PR の経緯)
