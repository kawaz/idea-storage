import type { TimelineChunk } from "../chunker.ts";

// --- チャンク分割パス用のプロンプトビルダー ---

/**
 * セクションプロンプトを生成する。
 * 各チャンクを個別に処理するための指示をレシピの指示と組み合わせる。
 */
export function buildSectionPrompt(
  recipePrompt: string,
  chunk: TimelineChunk,
  chunkText: string,
  sessionInfo: string,
): string {
  return `あなたはこれからセッションの一部分（チャンク）を読みます。
以下のレシピの指示に従って、このチャンクについてのセクションを書いてください。

--- レシピの指示 ---
${recipePrompt}
---

重要:
- このチャンクの内容に集中して、深く具体的に書いてください
- 短くまとめすぎないでください。このセクションはそのまま最終出力の一部になります
- セクション見出し（## ）を1つ付けてください。内容に合った見出しにしてください
- 他のチャンクの内容は知らなくて構いません

---
## チャンク情報
- チャンク: ${chunk.index + 1}/${chunk.label}
- ターン数: ${chunk.turnCount}

## セッション情報
${sessionInfo}

## 会話タイムライン（このチャンクの部分）
${chunkText}`;
}

/**
 * 合成プロンプトを生成する。
 * 各セクションの結果を統合して最終出力を作るための指示。
 */
export function buildSynthesisPrompt(sections: string[], sessionInfo: string): string {
  return `出力はMarkdown形式で。

以下は、あるセッションの出力を分割して書いたセクションです。
あなたの仕事は：

1. 全セクションをそのまま並べる（各セクションの見出しと本文はそのまま維持）
2. 冒頭にタイトル（# ）を付ける
3. 末尾に「## まとめ」セクションを追加する
   - 全体を通して感じたことを自分の言葉で書く
   - 各セクションの繰り返しにならないように、俯瞰的な視点で
   - セッション全体の流れや変化について

各セクションは編集しないでください。追加するのはタイトルとまとめだけです。

---
## セッション情報
${sessionInfo}

## セクション一覧
${sections.map((s, i) => `### --- セクション ${i + 1} ---\n${s}`).join("\n\n")}`;
}
