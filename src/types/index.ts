export interface Recipe {
  /** recipe-*.md のファイル名から recipe- を除いた部分 */
  name: string;
  filePath: string;
  match: {
    /** glob パターン */
    project?: string;
    minTurns?: number;
    /** seconds */
    minAge?: number;
  };
  /** default 'append' */
  onExisting: "append" | "separate" | "skip";
  /** frontmatter 以外の本文 */
  prompt: string;
  /**
   * DR-0008 §7: dispatcher が「向き・不向き」を判断する手がかりに使う
   * 自由テキスト 1 行ヒント。任意。
   */
  hint?: string;
  /**
   * DR-0008 §9: recipe 実行時、directly preceding N 本の過去出力 (同一 recipe)
   * を prompt 先頭に自動付加する。任意。未指定 / 0 で注入なし。
   */
  injectRecent?: number;
}

export interface SessionMeta {
  /** UUID */
  id: string;
  filePath: string;
  /** cwd */
  project: string;
  lineCount: number;
  ageSec: number;
  startTime: Date;
  endTime?: Date;
  userTurns: number;
  /** ツール結果などを除いた実質的なユーザー発話ターン数（CSA 由来） */
  effectiveUserTurns: number;
  /** フォークセッションの場合に設定される */
  forkInfo?: {
    parentSessionId: string;
    /** フォーク後の最初の行の UUID（CSA timeline との突合用） */
    firstNewUuid: string;
  };
}

export interface QueueEntry {
  sessionId: string;
  recipeName: string;
  /** {sessionId}.{recipeName} */
  key: string;
}

export interface Config {
  /** session JSONL 検索ディレクトリ */
  claudeDirs: string[];
  /** default 120 */
  minAgeMinutes: number;
}

export interface ConversationMessage {
  type: "USER" | "ASSISTANT" | "TOOL_USE" | "TOOL_RESULT" | "THINKING" | "SUMMARY" | "QUEUED";
  /** ローカル時刻文字列 */
  timestamp: string;
  content: string;
}
