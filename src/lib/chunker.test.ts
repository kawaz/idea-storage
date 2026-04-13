import { describe, expect, test } from "bun:test";
import { parseTimeline, buildTurns, splitTimeline, extractChunkText } from "./chunker.ts";

// --- テスト用ヘルパー ---

/** 最小限のCSAタイムラインテキストを生成する */
function makeTimeline(blocks: string[]): string {
  const header = [
    "---",
    "command: claude-session-analysis timeline xxx --md --no-emoji",
    "now: 2026-03-12T12:36:24.400+0900",
    "---",
  ].join("\n");
  return header + "\n\n" + blocks.join("\n---\n") + "\n";
}

/** 指定バイト数程度のコンテンツを持つUブロックを生成する */
function makeUserBlock(ts: string, contentBytes: number): string {
  const header = `${ts} Uf7f7f7e8\n\n`;
  const headerBytes = new TextEncoder().encode(header).length;
  const padding = "あ".repeat(Math.max(0, Math.ceil((contentBytes - headerBytes) / 3)));
  return header + padding;
}

/** 指定バイト数程度のコンテンツを持つRブロックを生成する */
function makeResponseBlock(ts: string, contentBytes: number): string {
  const header = `${ts} Re1893b08\n\n`;
  const headerBytes = new TextEncoder().encode(header).length;
  const padding = "い".repeat(Math.max(0, Math.ceil((contentBytes - headerBytes) / 3)));
  return header + padding;
}

// --- サンプルタイムライン ---

const SIMPLE_TIMELINE = makeTimeline([
  "2026-03-07T22:44:45+09:00 Uf7f7f7e8\n\nプロジェクトを評価してください。",
  "2026-03-07T22:44:49+09:00 Ta524a300\n\n思考内容...",
  "2026-03-07T22:44:50+09:00 Re1893b08\n\n応答内容...\n\n2026-03-07T22:44:55+09:00 Bd37f0283 wc -l /path/to/file\n2026-03-07T22:46:27+09:00 B8ba8c3fb grep -c ...",
]);

const TWO_TURN_TIMELINE = makeTimeline([
  "2026-03-07T22:44:45+09:00 Uf7f7f7e8\n\n最初の質問",
  "2026-03-07T22:44:50+09:00 Re1893b08\n\n最初の応答",
  "2026-03-07T23:00:00+09:00 Ua1a1a1a1\n\n二番目の質問",
  "2026-03-07T23:00:05+09:00 Rb2b2b2b2\n\n二番目の応答",
]);

// --- parseTimeline テスト ---

describe("parseTimeline", () => {
  test("ヘッダー(---で囲まれた部分)をスキップする", () => {
    const blocks = parseTimeline(SIMPLE_TIMELINE);
    // ヘッダーのcommandやnowがブロックに含まれていないこと
    expect(blocks.every((b) => !b.raw.includes("command:"))).toBe(true);
    expect(blocks.every((b) => !b.raw.includes("now:"))).toBe(true);
  });

  test("ブロックを正しく分割する", () => {
    const blocks = parseTimeline(SIMPLE_TIMELINE);
    // U, T, R の3ブロック（R内のBはインラインなので別ブロックにならない）
    expect(blocks).toHaveLength(3);
  });

  test("タイムスタンプを正しくパースする", () => {
    const blocks = parseTimeline(SIMPLE_TIMELINE);
    expect(blocks[0]!.timestamp).toEqual(new Date("2026-03-07T22:44:45+09:00"));
    expect(blocks[1]!.timestamp).toEqual(new Date("2026-03-07T22:44:49+09:00"));
    expect(blocks[2]!.timestamp).toEqual(new Date("2026-03-07T22:44:50+09:00"));
  });

  test("タイプ文字を正しくパースする", () => {
    const blocks = parseTimeline(SIMPLE_TIMELINE);
    expect(blocks[0]!.type).toBe("U");
    expect(blocks[1]!.type).toBe("T");
    expect(blocks[2]!.type).toBe("R");
  });

  test("IDを正しくパースする", () => {
    const blocks = parseTimeline(SIMPLE_TIMELINE);
    expect(blocks[0]!.id).toBe("f7f7f7e8");
    expect(blocks[1]!.id).toBe("a524a300");
    expect(blocks[2]!.id).toBe("e1893b08");
  });

  test("行番号が正しく設定される", () => {
    const blocks = parseTimeline(SIMPLE_TIMELINE);
    // ブロックの行番号は1-based
    expect(blocks[0]!.lineStart).toBeGreaterThan(0);
    // 各ブロックの行番号が昇順であること
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]!.lineStart).toBeGreaterThan(blocks[i - 1]!.lineEnd);
    }
  });

  test("rawBytesが正しく計算される", () => {
    const blocks = parseTimeline(SIMPLE_TIMELINE);
    const enc = new TextEncoder();
    for (const block of blocks) {
      expect(block.rawBytes).toBe(enc.encode(block.raw).length);
    }
  });

  test("Rブロック内のインラインツールコール(B,F,G等)は別ブロックにならない", () => {
    const blocks = parseTimeline(SIMPLE_TIMELINE);
    // Rブロックの raw にB行が含まれている
    const rBlock = blocks.find((b) => b.type === "R")!;
    expect(rBlock.raw).toContain("Bd37f0283");
    expect(rBlock.raw).toContain("B8ba8c3fb");
    // Bタイプのブロックが独立して存在しないこと
    expect(blocks.filter((b) => b.type === "B")).toHaveLength(0);
  });

  test("空テキストの場合は空配列を返す", () => {
    expect(parseTimeline("")).toEqual([]);
  });

  test("ヘッダーのみの場合は空配列を返す", () => {
    const headerOnly = "---\ncommand: test\nnow: 2026-01-01\n---\n";
    expect(parseTimeline(headerOnly)).toEqual([]);
  });
});

// --- buildTurns テスト ---

describe("buildTurns", () => {
  test("Uブロックでターンを区切る", () => {
    const blocks = parseTimeline(TWO_TURN_TIMELINE);
    const turns = buildTurns(blocks);
    expect(turns).toHaveLength(2);
  });

  test("最初のターンはUブロックで始まる", () => {
    const blocks = parseTimeline(TWO_TURN_TIMELINE);
    const turns = buildTurns(blocks);
    expect(turns[0]!.blocks[0]!.type).toBe("U");
  });

  test("各ターンにバイト数が正しく設定される", () => {
    const blocks = parseTimeline(TWO_TURN_TIMELINE);
    const turns = buildTurns(blocks);
    for (const turn of turns) {
      const expectedBytes = turn.blocks.reduce((s, b) => s + b.rawBytes, 0);
      expect(turn.bytes).toBe(expectedBytes);
    }
  });

  test("各ターンに行番号が正しく設定される", () => {
    const blocks = parseTimeline(TWO_TURN_TIMELINE);
    const turns = buildTurns(blocks);
    for (const turn of turns) {
      expect(turn.lineStart).toBe(turn.blocks[0]!.lineStart);
      expect(turn.lineEnd).toBe(turn.blocks[turn.blocks.length - 1]!.lineEnd);
    }
  });

  test("各ターンにstartTime/endTimeが正しく設定される", () => {
    const blocks = parseTimeline(TWO_TURN_TIMELINE);
    const turns = buildTurns(blocks);
    for (const turn of turns) {
      expect(turn.startTime).toEqual(turn.blocks[0]!.timestamp);
      expect(turn.endTime).toEqual(turn.blocks[turn.blocks.length - 1]!.timestamp);
    }
  });

  test("ターンのindexが0から連番で振られる", () => {
    const blocks = parseTimeline(TWO_TURN_TIMELINE);
    const turns = buildTurns(blocks);
    turns.forEach((turn, i) => {
      expect(turn.index).toBe(i);
    });
  });

  test("Uブロックがない場合は全体が1ターンになる", () => {
    // Uなしのブロック列
    const timeline = makeTimeline([
      "2026-03-07T22:44:49+09:00 Ta524a300\n\n思考",
      "2026-03-07T22:44:50+09:00 Re1893b08\n\n応答",
    ]);
    const blocks = parseTimeline(timeline);
    const turns = buildTurns(blocks);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.blocks).toHaveLength(2);
  });

  test("空配列の場合は空配列を返す", () => {
    expect(buildTurns([])).toEqual([]);
  });
});

// --- splitTimeline テスト ---

describe("splitTimeline", () => {
  test("小さいタイムライン → 1チャンク", () => {
    const chunks = splitTimeline(SIMPLE_TIMELINE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.turnCount).toBe(1);
  });

  test("空テキスト → 空配列", () => {
    const chunks = splitTimeline("");
    expect(chunks).toHaveLength(0);
  });

  test("大きいタイムライン → 複数チャンクに分割", () => {
    // 各ターンが約10KBのタイムラインを作る（maxChunkBytes=35000で分割される）
    const turnBlocks: string[] = [];
    for (let i = 0; i < 10; i++) {
      const hour = String(10 + i).padStart(2, "0");
      const ts = `2026-03-07T${hour}:00:00+09:00`;
      const tsR = `2026-03-07T${hour}:05:00+09:00`;
      turnBlocks.push(makeUserBlock(ts, 5000));
      turnBlocks.push(makeResponseBlock(tsR, 5000));
    }
    const timeline = makeTimeline(turnBlocks);
    const chunks = splitTimeline(timeline, { maxChunkBytes: 35000 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("日付境界で分割される", () => {
    // 2日にまたがるタイムラインを作る
    const turnBlocks: string[] = [];
    // Day 1: 十分なサイズのターン
    for (let i = 0; i < 5; i++) {
      const hour = String(20 + i).padStart(2, "0");
      turnBlocks.push(makeUserBlock(`2026-03-07T${hour}:00:00+09:00`, 8000));
      turnBlocks.push(makeResponseBlock(`2026-03-07T${hour}:05:00+09:00`, 8000));
    }
    // Day 2: 十分なサイズのターン
    for (let i = 0; i < 5; i++) {
      const hour = String(10 + i).padStart(2, "0");
      turnBlocks.push(makeUserBlock(`2026-03-08T${hour}:00:00+09:00`, 8000));
      turnBlocks.push(makeResponseBlock(`2026-03-08T${hour}:05:00+09:00`, 8000));
    }
    const timeline = makeTimeline(turnBlocks);
    const chunks = splitTimeline(timeline, { maxChunkBytes: 200000 });
    // 日付境界で分割されるので最低2チャンク
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 最初のチャンクの終了日と次のチャンクの開始日が異なること
    if (chunks.length >= 2) {
      const day1End = chunks[0]!.endTime.toLocaleDateString();
      const day2Start = chunks[1]!.startTime.toLocaleDateString();
      expect(day1End).not.toBe(day2Start);
    }
  });

  test("時間ギャップが大きい箇所で分割される", () => {
    const turnBlocks: string[] = [];
    // 密なターン群（午前）
    for (let i = 0; i < 3; i++) {
      const min = String(i * 5).padStart(2, "0");
      turnBlocks.push(makeUserBlock(`2026-03-07T10:${min}:00+09:00`, 10000));
      turnBlocks.push(makeResponseBlock(`2026-03-07T10:${min}:30+09:00`, 10000));
    }
    // 大きなギャップ（6時間）
    // 密なターン群（午後）
    for (let i = 0; i < 3; i++) {
      const min = String(i * 5).padStart(2, "0");
      turnBlocks.push(makeUserBlock(`2026-03-07T16:${min}:00+09:00`, 10000));
      turnBlocks.push(makeResponseBlock(`2026-03-07T16:${min}:30+09:00`, 10000));
    }
    const timeline = makeTimeline(turnBlocks);
    const chunks = splitTimeline(timeline, { maxChunkBytes: 80000 });
    // ギャップの位置で分割されること
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    if (chunks.length >= 2) {
      // 最初のチャンクの終了は午前ターン、次のチャンクの開始は午後ターン
      // Date.getHours() はローカルTZに依存するので、タイムスタンプ文字列で比較
      const chunk0EndISO = chunks[0]!.endTime.toISOString();
      const chunk1StartISO = chunks[1]!.startTime.toISOString();
      // chunk0 の終了時刻 < chunk1 の開始時刻（ギャップの位置で分割されている）
      expect(chunk0EndISO < chunk1StartISO).toBe(true);
      // 6時間のギャップがあるので、時刻の差が大きいはず
      const gapMs = chunks[1]!.startTime.getTime() - chunks[0]!.endTime.getTime();
      expect(gapMs).toBeGreaterThanOrEqual(5 * 3600 * 1000); // 少なくとも5時間以上のギャップ
    }
  });

  test("maxChunks を超えない", () => {
    const turnBlocks: string[] = [];
    for (let i = 0; i < 20; i++) {
      const hour = String(i % 24).padStart(2, "0");
      const day = String(7 + Math.floor(i / 24)).padStart(2, "0");
      turnBlocks.push(makeUserBlock(`2026-03-${day}T${hour}:00:00+09:00`, 5000));
      turnBlocks.push(makeResponseBlock(`2026-03-${day}T${hour}:05:00+09:00`, 5000));
    }
    const timeline = makeTimeline(turnBlocks);
    const maxChunks = 3;
    const chunks = splitTimeline(timeline, { maxChunkBytes: 10000, maxChunks });
    expect(chunks.length).toBeLessThanOrEqual(maxChunks);
  });

  test("minChunkBytes 未満のチャンクはマージされる", () => {
    // 1ターンが非常に小さい場合
    const turnBlocks: string[] = [];
    // 大きなターン
    turnBlocks.push(makeUserBlock("2026-03-07T10:00:00+09:00", 20000));
    turnBlocks.push(makeResponseBlock("2026-03-07T10:05:00+09:00", 20000));
    // 大きなギャップ後の小さなターン（minChunkBytes未満）
    turnBlocks.push(makeUserBlock("2026-03-07T20:00:00+09:00", 100));
    turnBlocks.push(makeResponseBlock("2026-03-07T20:05:00+09:00", 100));
    const timeline = makeTimeline(turnBlocks);
    const chunks = splitTimeline(timeline, {
      maxChunkBytes: 50000,
      minChunkBytes: 8192,
    });
    // 小さなチャンクはマージされて1チャンクになるはず
    expect(chunks).toHaveLength(1);
  });

  test("チャンクのlabel が生成される", () => {
    const chunks = splitTimeline(SIMPLE_TIMELINE);
    expect(chunks[0]!.label).toBeTruthy();
    expect(typeof chunks[0]!.label).toBe("string");
  });

  test("チャンクのindex が0から連番で振られる", () => {
    const turnBlocks: string[] = [];
    for (let i = 0; i < 10; i++) {
      const hour = String(10 + i).padStart(2, "0");
      turnBlocks.push(makeUserBlock(`2026-03-07T${hour}:00:00+09:00`, 5000));
      turnBlocks.push(makeResponseBlock(`2026-03-07T${hour}:05:00+09:00`, 5000));
    }
    const timeline = makeTimeline(turnBlocks);
    const chunks = splitTimeline(timeline, { maxChunkBytes: 20000 });
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
    });
  });

  test("チャンクのlineStart/lineEndが正しく設定される", () => {
    const chunks = splitTimeline(TWO_TURN_TIMELINE);
    for (const chunk of chunks) {
      expect(chunk.lineStart).toBeGreaterThan(0);
      expect(chunk.lineEnd).toBeGreaterThanOrEqual(chunk.lineStart);
    }
  });
});

// --- extractChunkText テスト ---

describe("extractChunkText", () => {
  test("lineStart-lineEnd の範囲を正しく抽出する", () => {
    const chunks = splitTimeline(SIMPLE_TIMELINE);
    const lines = SIMPLE_TIMELINE.split("\n");
    const text = extractChunkText(lines, chunks[0]!);
    // チャンクテキストに元のコンテンツが含まれていること
    expect(text).toContain("プロジェクトを評価してください。");
    expect(text).toContain("応答内容...");
  });

  test("複数チャンクの場合、各チャンクが正しい範囲を抽出する", () => {
    const turnBlocks: string[] = [];
    for (let i = 0; i < 10; i++) {
      const hour = String(10 + i).padStart(2, "0");
      turnBlocks.push(makeUserBlock(`2026-03-07T${hour}:00:00+09:00`, 5000));
      turnBlocks.push(makeResponseBlock(`2026-03-07T${hour}:05:00+09:00`, 5000));
    }
    const timeline = makeTimeline(turnBlocks);
    const lines = timeline.split("\n");
    const chunks = splitTimeline(timeline, { maxChunkBytes: 20000 });

    if (chunks.length >= 2) {
      const text0 = extractChunkText(lines, chunks[0]!);
      const text1 = extractChunkText(lines, chunks[1]!);
      // 各チャンクのテキストが空でないこと
      expect(text0.length).toBeGreaterThan(0);
      expect(text1.length).toBeGreaterThan(0);
      // 重複しないこと（行範囲が異なる）
      expect(chunks[0]!.lineEnd).toBeLessThan(chunks[1]!.lineStart);
    }
  });

  test("抽出されたテキストの行数がlineEnd - lineStart + 1であること", () => {
    const chunks = splitTimeline(SIMPLE_TIMELINE);
    const chunk = chunks[0]!;
    const lines = SIMPLE_TIMELINE.split("\n");
    const text = extractChunkText(lines, chunk);
    const lineCount = text.split("\n").length;
    expect(lineCount).toBe(chunk.lineEnd - chunk.lineStart + 1);
  });
});
