import { join } from "node:path";

export const SERVICE_LABEL = "com.idea-storage.session";

export function getLaunchAgentsDir(): string {
  const home = process.env.HOME ?? "/";
  return join(home, "Library", "LaunchAgents");
}

export function getPlistPath(): string {
  return join(getLaunchAgentsDir(), `${SERVICE_LABEL}.plist`);
}

export function getLaunchdDomain(): string {
  const uid = process.getuid?.() ?? 0;
  return `gui/${uid}`;
}

export function getProgramPath(): string {
  // launchd plist に書く絶対パスは `bin/idea-storage` (bash wrapper)。
  // PATH / alias / which に依存せず、本ファイルからリポ root を解決して
  // bin/ を組み立てる (= 自分が誰か自分で知ってる、外部に聞かない)。
  //
  // service.ts は src/lib/ 配下なので、`../..` でリポ root。
  const repoRoot = join(import.meta.dir, "..", "..");
  return join(repoRoot, "bin", "idea-storage");
}
