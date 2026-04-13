export interface HelpSection {
  title: string;
  lines: string[];
}

/**
 * gunshi の renderUsage 出力を修正するヘルパー。
 *
 * - COMMANDS セクションから自分自身の行（[name] <OPTIONS>）を除去
 * - USAGE 行の [COMMANDS] を commandPath 付きの COMMANDS に修正
 * - OPTIONS -> GLOBAL OPTIONS にリネーム
 * - 追加セクション（ENVIRONMENTS 等）を GLOBAL OPTIONS の前に挿入
 */
export async function showHelp(
  ctx: {
    name: string | undefined;
    commandPath: string[];
    env: { name: string | undefined; renderUsage: (ctx: any) => Promise<string> };
    log: (msg: string) => void;
  },
  options?: { sections?: HelpSection[] },
) {
  let usage = await ctx.env.renderUsage(ctx);

  // USAGE: より前の行（description 等）を除去
  usage = usage.replace(/^[\s\S]*?(?=USAGE:)/, "");

  // commandPath は root では空配列、サブコマンドでは ['process'] 等
  // フルパス: env.name (= CLI名) + commandPath
  const fullPath = [ctx.env.name ?? "", ...ctx.commandPath].filter(Boolean).join(" ");
  const currentName = ctx.commandPath.length > 0 ? ctx.commandPath.at(-1)! : (ctx.name ?? "");

  // COMMANDS セクションから自分自身の行を除去: "  [name] <OPTIONS>  ..."
  const selfPattern = new RegExp(`^  \\[${escapeRegExp(currentName)}\\] <OPTIONS>\\s+.*$\\n?`, "m");
  usage = usage.replace(selfPattern, "");

  // USAGE 行を修正: "idea-storage [COMMANDS] <OPTIONS>" -> "idea-storage process COMMANDS <OPTIONS>"
  usage = usage.replace(/^(  )\S+ \[COMMANDS\]/m, `$1${fullPath} COMMANDS`);

  // "For more info, run any command with the `--help` flag:" セクションを除去
  usage = usage.replace(/\nFor more info,[\s\S]*?(?=\n\n)/m, "");

  // OPTIONS -> GLOBAL OPTIONS にリネーム
  usage = usage.replace(/^OPTIONS:/m, "GLOBAL OPTIONS:");

  // 追加セクションを GLOBAL OPTIONS の前に挿入
  if (options?.sections?.length) {
    const extra = options.sections
      .map((s) => `${s.title}:\n${s.lines.map((l) => `  ${l}`).join("\n")}`)
      .join("\n\n");
    usage = usage.replace(/^GLOBAL OPTIONS:/m, `${extra}\n\nGLOBAL OPTIONS:`);
  }

  // 連続する空行を1つに
  usage = usage.replace(/\n{3,}/g, "\n\n");

  ctx.log(usage);
}

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
