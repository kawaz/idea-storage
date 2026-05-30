# 2026-05-30: DR-0008 §9 + §10 — 過去出力注入 + claude model/version 記録

## 達成

DR-0008 §9 (過去出力注入) と §10 (出力 frontmatter に claude_model/claude_version) を 1 PR で完了。

- `bun test`: 759 pass / 0 fail (PR④ 時 752 → +7: recent-outputs.test.ts)
- typecheck clean
- 新規: `src/lib/recent-outputs.ts` (+ test), `src/lib/claude-meta.ts`

## §9 inject_recent

- recipe frontmatter `inject_recent: N` を `Recipe.injectRecent?: number` に parse
- `processSession` の prompt 構築直後に、`{dataDir}/{recipeName}/**/*.md` を Bun.Glob で再帰走査
- ファイル名 timestamp 順 (= `yyyymmddTHHMMSSZ.<sid>.md`) で sort → 末尾 N 本を newest-first で取得
- `formatInjectedRecent()` でブロック化して prompt 先頭に prepend
- 既存ファイル不在 / N=0 / 未指定は no-op
- DB index は使わない (filesystem 直接走査、DR-0008 §9 の方針通り)

## §10 claude meta

- `src/lib/claude-meta.ts` 新設: `getClaudeMeta()` がプロセス内 1 回だけ
  `claude --version` を spawn して結果をキャッシュ
- model は `process.env.ANTHROPIC_MODEL` → `process.env.CLAUDE_MODEL` の順で観察 (CLI 自体に動的に「現在の model」を返す API はないため env を信頼)
- frontmatter に `claude_model` / `claude_version` を追加 (null も書き込む)
- spawn 失敗時は null フォールバック (frontmatter には null として記録)

## 変更ファイル

| ファイル                          | 内容                                                  |
| --------------------------------- | ----------------------------------------------------- |
| `src/lib/recent-outputs.ts`       | 新規。listRecentOutputs / formatInjectedRecent        |
| `src/lib/recent-outputs.test.ts`  | 新規。7 ケース                                        |
| `src/lib/claude-meta.ts`          | 新規。getClaudeMeta + 1 回キャッシュ                  |
| `src/lib/recipe.ts`               | inject_recent frontmatter を parse                    |
| `src/types/index.ts`              | Recipe.injectRecent?: number 追加                     |
| `src/commands/session-process.ts` | prompt 先頭注入 + frontmatter に claude_model/version |

## 残課題

- §11 観測指標 (`session status` の skipped breakdown)
- Phase 4 (DR-0009): quality_guidelines.md 自動更新
- session-process.test.ts の end-to-end (gate / dispatcher / inject の統合)
- session-enqueue.test.ts から queue.ts mock 撤去

## 関連

- DR-0008 §9, §10
- PR④ journal: `docs/journal/2026-05-30-pr4-quality-gate.md`
