export interface Recipe {
  /** recipe-*.md のファイル名から recipe- を除いた部分 */
  name: string
  filePath: string
  match: {
    /** glob パターン */
    project?: string
    minLines?: number
    maxLines?: number
    /** seconds */
    minAge?: number
    /** seconds */
    maxAge?: number
    requireSessionEnd?: boolean
  }
  /** default 0 */
  priority: number
  /** default 'append' */
  onExisting: 'append' | 'separate' | 'skip'
  outputMode?: 'stdout'
  /** frontmatter 以外の本文 */
  prompt: string
}

export interface SessionMeta {
  /** UUID */
  id: string
  filePath: string
  /** cwd */
  project: string
  lineCount: number
  ageSec: number
  /** summary イベントの有無 */
  hasEnd: boolean
  startTime: Date
  endTime?: Date
  userTurns: number
}

export interface QueueEntry {
  sessionId: string
  recipeName: string
  /** {sessionId}.{recipeName} */
  key: string
}

export interface Config {
  /** session JSONL 検索ディレクトリ */
  claudeDirs: string[]
  /** default 120 */
  minAgeMinutes: number
  /** default 10080 */
  maxAgeMinutes: number
}

export interface ConversationMessage {
  type: 'USER' | 'ASSISTANT' | 'TOOL_USE' | 'TOOL_RESULT' | 'THINKING' | 'SUMMARY' | 'QUEUED'
  /** ローカル時刻文字列 */
  timestamp: string
  content: string
}
