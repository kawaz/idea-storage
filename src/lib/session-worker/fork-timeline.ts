// --- フォークセッション用のタイムライン切り詰め ---

/**
 * フォークセッションのタイムラインから、フォーク後の新規部分のみを抽出する。
 * firstNewUuid の先頭8文字を CSA ブロックID として検索し、
 * そのブロック以降（--- 区切り含む）を返す。
 */
export function trimTimelineForFork(timelineText: string, firstNewUuid: string): string {
  if (!firstNewUuid) return timelineText;

  const blockIdPrefix = firstNewUuid.slice(0, 8);
  const lines = timelineText.split("\n");

  // ヘッダー（最初の --- ... --- ペア）を特定
  let headerEnd = 0;
  if (lines[0]?.trim() === "---") {
    let i = 1;
    while (i < lines.length && lines[i]?.trim() !== "---") i++;
    headerEnd = i + 1; // 閉じの --- の次
  }

  // CSA ブロックID パターン: タイプ文字(U,T,B,F,G,R,W,S等) + 8文字hex
  // .includes() だとメッセージ本文中の偶然の一致で誤マッチするため、
  // CSA のブロックIDフォーマットに限定してマッチする
  const blockIdPattern = new RegExp(`[A-Z]${blockIdPrefix}\\b`);

  // ブロックIDを含む行を探す
  for (let i = headerEnd; i < lines.length; i++) {
    if (blockIdPattern.test(lines[i] ?? "")) {
      // この行を含むブロックの開始位置（直前の --- か headerEnd）を見つける
      let blockStart = i;
      for (let j = i - 1; j >= headerEnd; j--) {
        if (lines[j]?.trim() === "---") {
          blockStart = j;
          break;
        }
      }
      // ヘッダー + このブロック以降を返す
      const header = lines.slice(0, headerEnd).join("\n");
      const body = lines.slice(blockStart).join("\n");
      return header + "\n" + body;
    }
  }

  // 見つからない場合はそのまま返す
  return timelineText;
}
