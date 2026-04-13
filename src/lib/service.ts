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

export async function getProgramPath(): Promise<string> {
  // Use the absolute path to the built binary
  const proc = Bun.spawn(["which", "idea-storage"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  if (stdout.trim()) {
    return stdout.trim();
  }

  // Fallback: use the dist path relative to this project
  // Resolve from process.argv[0] which is the running binary
  return process.argv[1] ?? "idea-storage";
}
