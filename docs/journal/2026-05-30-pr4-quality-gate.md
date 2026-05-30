# 2026-05-30: DR-0008 Phase 3 §8 完成 — 品質ガード

## 達成

DR-0008 §8 の品質ガードを processSession 末尾に統合。出力 LLM 判定 (二値) で
不採用なら `_rejected/<recipe>/YYYY/MM/DD/<file>.md` に退避して
`skipped(quality_rejected, lineCount=N)` を返す。

- `bun test`: 752 pass / 0 fail (PR③ 時 745 → +7: quality-gate.test.ts 7 件)
- `bunx tsc --noEmit`: clean
- 新規ファイル: `src/lib/quality-gate.ts`, `src/lib/quality-gate.test.ts`,
  `config-examples/quality_guidelines.md`

## 主要な設計判断

### 1. ガード失敗時は accepted フォールバック (保守的)

DR-0008 §8 は「不採用判定の精度」を後で検証可能にする方針。逆方向の失敗 (=
本来採用すべきものを誤って \_rejected/ に流す) は、ガードが unstable な間は
避けたい。そこで:

- LLM 接続/タイムアウト/spawn エラー: fallback=accepted (`quality_gate_unreachable`)
- JSON parse 失敗: fallback=accepted (`quality_gate_parse_fail`)
- `kind` が `"rejected"` でない値 (`accepted` / `maybe` / 空): defensive accepted

「判定 unstable な側で間違うより、出力を残す側で間違える方が安い」。reject は
LLM が明示的に `"rejected"` を返したときだけ発火。

### 2. quality_guidelines.md は stateDir で配布

`stateDir/quality_guidelines.md` (= `~/.local/state/idea-storage/quality_guidelines.md`)
に置く。理由:

- DR-0008 Phase 4 で「自動更新ジョブ」を計画 → state は mutate される前提
- ユーザは `config-examples/quality_guidelines.md` を state にコピーして使う
- ファイル不在時は内部の `DEFAULT_GUIDELINES` (短縮版) で動く

### 3. \_rejected/ は dataDir/\_rejected/<recipe>/YYYY/MM/DD/ 構造

通常出力 (`<dataDir>/<recipe>/YYYY/MM/DD/...md`) と同じ階層配下に `_rejected/`
を mirror する。理由:

- 同じ recipe + 同じ日付の通常出力と \_rejected の比較が grep しやすい
- 後で `quality_guidelines.md` を改修した際の手動再評価で参照しやすい
- _rejected の prefix `_` で「通常 read 対象でない」を表現 (recipe 名と
  衝突しないことの保証)

### 4. processSession の戻り値: `kind: "skipped", reason: "quality_rejected"`

caller (`runProcess`) は既存ロジックで `markSkipped(sessionId, recipeName,
result.reason, result.lineCount)` を呼ぶ。`quality_rejected` は queue.ts の
`REENQUEUABLE_SKIPPED_REASONS` に **含まれない** ので、§5.1 ルールにより
追記があっても自動 queued 復帰しない (= 同セッション再実行で同じ結果になる
ことが想定されるため; `quality_guidelines.md` 更新時は `idea-storage session
convert` で明示的に再実行する)。

### 5. ガードへの入力は本文のみ (frontmatter を含めない)

`processSession` が `output` (LLM 出力本文) と `fm` (frontmatter) を分けて
持っているのを利用し、品質判定には `output` だけを渡す。frontmatter は
session_id 等のメタで「内容の質」とは関係ないため。

## ハマり所 → 解決策

### redact integration test の runClaude 回数期待

`processSession redact integration` の既存テストは「runClaude が 1 回呼ばれた」
を厳密に確認していた。Phase 3 では main process + quality gate で最低 2 回
呼ばれる。

**解決**: `.toBe(1)` → `.toBeGreaterThanOrEqual(1)` に緩和。redact 判定は
`runClaudeCalls[0]` (main process call) を見るだけで成立する。

## 変更ファイル

7 ファイル:

| ファイル                                | 内容                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `src/lib/quality-gate.ts`               | 新規。`runQualityGate()`, `loadQualityGuidelines()`, fallback ロジック  |
| `src/lib/quality-gate.test.ts`          | 新規。7 件の単体テスト                                                  |
| `config-examples/quality_guidelines.md` | 新規。ガイドライン雛形                                                  |
| `src/lib/paths.ts`                      | `getQualityGuidelinesPath()`, `getRejectedDir()` 追加                   |
| `src/commands/session-process.ts`       | processSession 末尾に quality gate 呼び出し + `_rejected/` 退避ロジック |
| `src/commands/session-process.test.ts`  | redact integration test の runClaude 回数期待を緩和                     |

## DR-0008 Phase 1+2+3 のまとめ

| Phase | PR  | 内容                                                             | main commit                      |
| ----- | --- | ---------------------------------------------------------------- | -------------------------------- |
| 1     | ①   | CSA jsonl 移行 + fixture+実 CSA test 化                          | `10e043a6` (+ CI fix `1044f058`) |
| 1     | ②   | §5.1 UPSERT 遷移ルール + no_effective_turn skip                  | `a256eb91`                       |
| 2     | ③   | dispatcher (二段キュー) + recipe.hint + dispatcher_rejected 復帰 | `7404b6a4`                       |
| 3     | ④   | 品質ガード + `_rejected/` 退避                                   | (本 PR)                          |

## 残課題

1. **§9 過去出力注入** (`inject_recent: N` frontmatter): 本 PR でスコープ外。
   別 PR で `inject_recent: N` 解析 + recipe prompt 先頭に直近 N 本付加
2. **§10 出力 frontmatter に `claude_model` / `claude_version`**: 起動時に
   `claude --version` をキャッシュして frontmatter に挿入
3. **§11 観測指標**: `idea-storage session status` に
   `Skipped breakdown (no_effective_turn / dispatcher_rejected / quality_rejected)` を追加
4. **Phase 4 (DR-0009 予定)**: `quality_guidelines.md` 自動更新ループ
5. **session-process.test.ts に quality gate 統合テスト**: gate が rejected を
   返したとき `_rejected/` に書き込まれ skipped が記録される end-to-end 検証
6. **session-enqueue.test.ts から queue.ts mock 撤去**: PR① 方針との整合
   (PR② / PR③ 共通の残課題)

## 関連

- DR-0008 §8: 品質ガード正本
- PR③ journal: `docs/journal/2026-05-30-pr3-dispatcher.md`
- PR② journal: `docs/journal/2026-05-30-pr2-upsert-transition-rules.md`
- PR① journal: `docs/journal/2026-05-30-pr1-csa-fixture-migration.md`
