# 2026-05-31: mock 完全撤去 — 前回断念の真因と解決

## 達成

PR① で確立した「mock は筋悪、契約は実機で検証」方針を、`session-enqueue.test.ts` / `session-convert.test.ts` / `session-process.test.ts` の **3 ファイル全部に適用完了**。CSA を含む内部モジュールの mock は全撤去、claude CLI (claude-runner) だけ mock 維持 (= 真の外部 API)。

- main commit: `33a0fa15`
- `bun test`: 759 pass / 0 fail
- `bun test --isolate`: 759 pass / 0 fail
- typecheck clean

## 前回 journal の誤診断を訂正

`2026-05-31-mock-removal-attempt.md` で「`process.env` mutation が他テストファイルに漏れる」と書いたのは **完全に誤り**。実機検証で:

- ファイル間で `process.env` mutation は **漏れない** (bun が自動隔離)
- 同一ファイル内 test 間でも、`try/finally` か `afterEach` で restore してれば問題なし

つまり `withIsolatedIdeaStorageEnv` の設計自体に問題はなかった。

## 真の原因: `mock.module()` が dynamic import 経由でファイル間に漏れる

実機検証で発見した bun test 1.3.13 の挙動:

| import 形式                        | mock.module の効果範囲                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `import { x } from "./m"` (static) | **ファイルローカル** — 他テストファイルに漏れない                               |
| `await import("./m")` (dynamic)    | **グローバルに漏れる** — 他テストファイルからの dynamic import に hijack される |

検証コード (`/tmp/bun-env-test/dyn-{a,b}.test.ts`):

```ts
// a.test.ts
mock.module("./user-sut.ts", () => ({ greet: () => "MOCKED-A" }));
test("a calls greet via dynamic import", async () => {
  const { greet } = await import("./user-sut.ts");
  expect(greet()).toBe("MOCKED-A"); // ✓ pass
});

// b.test.ts (mock なし)
test("b calls greet via dynamic import", async () => {
  const { greet } = await import("./user-sut.ts");
  console.log(greet()); // → "MOCKED-A" (!!!)
  expect(greet()).toBe("real"); // ✗ fail
});
```

→ a.test.ts の mock が b.test.ts の dynamic import に効いてしまう。

### なぜ前回の半部分撤去で詰まったか

- `session-enqueue.test.ts` だけ mock 撤去 → 内部の `runEnqueue` は static import で `loadConfig` を持つ → これは `import("./session-enqueue.ts")` (dynamic) 経由で読まれる
- `session-process.test.ts` がまだ `mock.module("../lib/config.ts", ...)` を持ってる
- 結果: dynamic import 経路で hijack され、`loadConfig()` が session-process の `loadConfigResult` (= session-process の tempDir) を返す
- debug log で観察: `getConfigDir()` は正しい debug tempDir、なのに `loadConfig()` は session-process-test-99gZRm/.claude を返してた → 何かが loadConfig を override してる証拠

### 解決

**全テストファイルで内部 mock を一斉撤去する以外に道がない**。半部分撤去は他ファイルに漏れて死ぬ。

`claude-runner.ts` (= claude CLI) だけは真の外部 API なので mock 維持 OK。

## 設計判断

### 1. test-fixtures.ts に統合ヘルパを集約

- `withIsolatedIdeaStorageEnv(base, fn)`: HOME / CLAUDE*CONFIG_DIR / XDG*{CONFIG,STATE,DATA}\_HOME を全 override
- `writeConfigFixture(base, opts)`: `<base>/.config/idea-storage/config.ts` を実 loadConfig が読む形で書く
- `writeRecipeFixtures(base, specs)`: `recipe-*.md` を実 loadRecipes が読む形で書く
- PR① 由来の `createCsaFixtureDir` / `writeSessionFixture` と composable

### 2. spawn-timeout.ts に `env: { ...process.env }` 明示

PR① で `conversation.ts` の `Bun.spawn` に同じ修正を入れたのと同じパターン。`Bun.spawn` は `env` 引数を省略すると起動時の env を snapshot するため、テスト中の env mutation が CSA 子プロセスに届かない。`{ ...process.env }` を明示すると spawn 時の現在値が反映される。

### 3. session-process.ts に純関数 export を追加

`countTimelineSeparators()` / `isValidCsaTimeline()` を export。実 CSA は exitCode=0 で malformed timeline を出さない (= 統合テストで validation 経路を再現できない)。純関数として export して unit test で invariant を検証する。

トレードオフ: `if (!isValidCsaTimeline(...))` の配線部分は end-to-end でカバーされなくなった。helper-level の invariant は守られる。

### 4. session-process は claude-runner mock を per-test inline で

file-scope で `mock.module("../lib/claude-runner.ts", ...)` してしまうと、`processChunked` テストが file-level static import の `ClaudeAbortError` クラスを `instanceof` で検査する箇所が壊れる (mock の class が別 identity になるため)。

→ test ごとに inline で mock.module する形に。これは PR① 方針と整合 (= 必要最小限の mock を必要なスコープで)。

## 残課題

1. **session-convert wait 系 3 テストのタイミング依存**: preClaim + sleep + markDone/Failed/Skipped の協調が固定 sleep に依存。重 CI 下で flake する可能性。flake したら sleep を延ばす方向で対応
2. **`if (!isValidCsaTimeline(...))` の配線カバレッジ**: helper-level のみ。統合テストで再現可能になったら追加検討 (CSA に malformed mode フラグが入る等)
3. **DR-0009 (Phase 4)**: quality_guidelines.md 自動更新ループ — DR-0008 完了時から保留中

## 関連

- 前回 (誤診断) journal: `docs/journal/2026-05-31-mock-removal-attempt.md`
- PR① journal: `docs/journal/2026-05-30-pr1-csa-fixture-migration.md`
- メモリ: `feedback_csa_jsonl_all_fields_optional`
