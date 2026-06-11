# 変換サービス全停止 (5/30〜) の復旧

「変換動いてる?」の確認から始まり、launchd サービスが 5/30 頃から毎時クラッシュ
し続けていたのを発見・復旧した記録。問題は 4 層重なっていた。

## 症状

- `launchctl list` で last exit code 1、runs 133 (= 毎時起動しては死んでいた)
- queue は Queued 3332 のまま停止、rate limit 観測も 5/28 で途絶
- stderr: `claude-session-analysis returned no record for session 6411e4aa-...`

## 原因 1: snapshot-only jsonl で enqueue が毎回 throw

`6411e4aa-...jsonl` は 3 行・6KB で `file-history-snapshot` 行のみ (実会話なし)。
CSA はこれを session として認識せず record を emit しない。csa.ts の fallback は
「0 byte のみ合成 meta」だったため、非空のこのファイルは「真の不整合」扱いで
throw → enqueue 走査全体が毎回ここで死んでいた。

**修正** (`fix(csa)`): record なしは 0 byte に限らず合成 meta (lineCount 0) で
skip 経路へ。実際に走らせると同種ファイルが **356 個** あった (= 最初の 1 個で
死んでいたので全貌が見えていなかった)。なお id 自体が CSA の探索 scope に無い
場合は CSA が exit 1 (`Session not found`) を返すので従来通り throw で表面化する。

あわせて enqueue-driver に per-session try/catch を追加。codex review の指摘
(系統的失敗まで握りつぶし全 skip でも成功報告になる) を受け、連続
`MAX_CONSECUTIVE_FAILURES` (5) 回の meta 失敗で CliError に bail する形に補強
(`fix(enqueue/service)`)。

## 原因 2: plist が廃止済み dist bundle を指したまま

DR-0009 Phase 8 で bundle 廃止 → `bin/idea-storage` (bash wrapper) 方式に
移行したが、`service register` のやり直しが漏れており、plist は
`~/.local/bin/idea-storage` → `dist/idea-storage` (6/2 ビルドの残骸) を
指したままだった。ソースを直しても launchd には反映されない状態。

**修正**: `service register` 再実行で plist を bash wrapper 経路に更新、
`dist/` 削除。さらに wrapper が symlink 経由実行で `src/index.ts` を解決
できない bug を発見し `readlink -f` で実体解決するよう修正 (`fix(bin)`)。
`~/.local/bin/idea-storage` の symlink も wrapper へ向け直した。

## 原因 3: launchd 環境に CLAUDE_CONFIG_DIR が無く claude CLI が全滅

enqueue 復旧後、worker の claude CLI spawn が全件
`API Error: EEXIST: file already exists, mkdir '/Users/kawaz/.claude'` で
exit 1 → bail_out。launchd の plist には PATH しか焼き込まれておらず、
`CLAUDE_CONFIG_DIR` が無いため claude CLI が `~/.claude` (この環境では
走査汚染対策で意図的に regular file) を作ろうとして死んでいた。

**修正** (`fix(enqueue/service)`): `service register` 時の
`CLAUDE_CONFIG_DIR` を plist の EnvironmentVariables に焼き込む。

## 原因 4: claude 2.1.x の JSON 出力形式変更で debug ログが記事として保存

パイプライン復旧後に生成された 8 件の中身が markdown でなく
`[log_xxx] sending request {...}` という API リクエストの debug ダンプに
なっていた (kawaz が発見、サービス一時停止)。

メカニズムは 2 段の fallback の積み重ね:

1. `captureUsage` モードは `ANTHROPIC_LOG=debug` + `--output-format json` で
   claude を呼び、stdout 末尾の result JSON から本文を抽出する。claude CLI
   2.1.x で出力が `{"type":"result",...}` 単体行から
   `[{"type":"system",...},...,{"type":"result",...}]` の**単一行 JSON 配列**に
   変わり、`line.startsWith("{")` の抽出条件にマッチせず抽出失敗
2. 抽出失敗時の「raw stdout を返す」fallback により、debug ログ全体が
   記事本文として保存された。quality gate も汚染応答の parse 失敗 →
   accepted fallback (DR-0008 の意図的設計) で素通し

**修正** (`fix(claude-runner)`): 配列形式対応 + raw stdout fallback を廃止して
throw (failed/retry に乗せる)。result 不在の captureUsage stdout はほぼ確実に
ゴミなので、「何か見える方がまし」より silent corruption 防止を優先。

**汚染ファイルの復旧**: 8 件とも末尾の JSON 配列内に正しい記事 (`result`
フィールド) が残っていたため、再生成せず one-off スクリプトで frontmatter を
維持したまま本文をサルベージ (redactForOutput 経由) した。

## 教訓的メモ (運用観点)

- launchd サービスは「コード修正 + push」だけでは直らない。plist が指す
  実体 (bundle / wrapper) と環境変数の焼き込みは `service register` の
  再実行が必要
- enqueue のような走査 loop での throw は「1 件の異常データで全停止」に
  直結する。per-item catch + 連続失敗 bail の対が必要 (片方だけだと
  全停止 or 系統的失敗の隠蔽のどちらかに倒れる)
- サービス監視: last exit code / runs は `launchctl print` で見える。
  stdout log の `enqueue_done` / `bail_out` が生存確認の起点
- 外部 CLI の出力形式は version で変わる。「parse 失敗 → 入力をそのまま使う」
  系の fallback は silent corruption の温床 (失敗は失敗として fail させ、
  retry 機構に乗せる方が復旧可能性が高い)
- 「exit 0 で生成物が置かれた」は正常性の証明にならない。生成物の
  中身レベルの検証 (形式 / 汚染マーカーの grep) まで見て初めて復旧完了
