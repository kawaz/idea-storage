# DR-003: フォークセッションの日誌生成改善

## 背景

Claude Code のセッションフォーク時、フォーク側のJSONLに親セッションの全履歴がコピーされる。このため、フォーク側セッションの日誌が親セッションと9割同じ内容になり、重複した日記が生成される問題がある。

## 調査結果

- フォーク行のJSONLには `forkedFrom: {sessionId, messageUuid}` フィールドが付与される
- `forkedFrom` あり＝親からのコピー、なし＝フォーク後の新規会話
- 境界は連続的（先頭がコピー部分、途中から新規部分）
- `forkedFrom` が存在する最後の行の次がフォーク後の最初の新規イベント
- CSA timeline のブロックID（例: `Uf7f7f7e8`）はJSONLのUUIDの先頭8文字に対応

## 設計判断

### フォーク検出とメタデータ

SessionMeta に forkInfo を追加:

- `forkInfo?: { parentSessionId: string; firstNewUuid: string }`
- JSONL パース時に `forkedFrom` フィールドの有無で検出
- `firstNewUuid`: 最初の非フォーク行の UUID（CSA timeline との突合に使用）

フォークセッションのメタデータは**非フォーク行のみ**で計算する:

- `startTime`: 最初の非フォーク行のタイムスタンプ（親のstartTimeではない）
- `lineCount`: 非フォーク行のみのカウント
- `userTurns`: 非フォーク行のみの user ターン数

理由: レシピマッチングの `minLines` が親の行数で判定されると、1行しかないフォークが巨大セッション扱いになる。出力パスの日付やフロントマターも親の開始時刻ではなくフォーク時点を使うべき。

### タイムライン切り詰め方法

CSA timeline をそのまま取得した後、`firstNewUuid` の先頭8文字をキーにしてCSAブロックを特定し、そのブロック以降のみを抽出する。

UUID ベースの突合を採用した理由:
- タイムスタンプベースだと秒精度のズレで誤判定リスクがある（同一秒内に複数イベント）
- CSA ブロックID = UUID の先頭8文字なので、確実な1:1対応が可能

### プロンプトへのフォーク情報付加

フォークセッションの場合、プロンプトに以下を追加:
- 「このセッションは元セッション {parentSessionId} からフォークされたものです」
- 「以下のタイムラインはフォーク後の新規会話のみです」

## 変更ファイル

1. `src/types/index.ts` -- SessionMeta に forkInfo フィールド追加
2. `src/lib/conversation.ts` -- getSessionMeta() でフォーク情報を検出、メタデータを非フォーク行のみで計算
3. `src/commands/session-process.ts` -- UUIDベースのタイムライン切り詰め・プロンプト調整

## 不採用案

- **タイムスタンプベースの切り詰め**: 秒精度のCSA vs ミリ秒精度のJSONLで境界の誤判定リスク
- **CSA のレンジ指定で最初からフィルタする案**: CSA の内部仕様への依存が発生する
- **JSONL を前処理してフォーク行を削除する案**: 一時ファイルの管理が必要になり複雑
