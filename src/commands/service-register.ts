import { define } from "gunshi";
import { mkdir } from "node:fs/promises";
import { generatePlist } from "../lib/service/plist.ts";
import { CliError } from "../lib/errors.ts";
import {
  SERVICE_LABEL,
  getLaunchAgentsDir,
  getLaunchdDomain,
  getPlistPath,
  getProgramPath,
} from "../lib/service/service.ts";

const register = define({
  name: "register",
  description: "Install/update launchd plist and register the service",
  run: async () => {
    const program = getProgramPath();

    const plist = generatePlist({
      label: SERVICE_LABEL,
      program,
      programArguments: [program, "session", "run"],
      startInterval: 3600,
      exitTimeOut: 3600,
      environmentVariables: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        // launchd 環境には CLAUDE_CONFIG_DIR が無く、worker が spawn する
        // claude CLI が ~/.claude を作ろうとして失敗する環境がある
        // (kawaz 環境では ~/.claude は意図的に regular file)。register 実行時の
        // 値を焼き込んで、サービスでも同じ設定面を使わせる。
        ...(process.env.CLAUDE_CONFIG_DIR
          ? { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR }
          : {}),
      },
    });

    const launchAgentsDir = getLaunchAgentsDir();
    await mkdir(launchAgentsDir, { recursive: true });
    const plistPath = getPlistPath();

    await Bun.write(plistPath, plist);
    console.log(`Written: ${plistPath}`);

    // Unload existing job (ignore errors if not loaded)
    const domain = getLaunchdDomain();

    try {
      const bootout = Bun.spawn(["launchctl", "bootout", `${domain}/${SERVICE_LABEL}`], {
        stdout: "pipe",
        stderr: "pipe",
      });
      await bootout.exited;
    } catch {
      // Ignore if not loaded
    }

    // Load the new job
    const bootstrap = Bun.spawn(["launchctl", "bootstrap", domain, plistPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(bootstrap.stderr).text();
    const exitCode = await bootstrap.exited;

    if (exitCode !== 0) {
      throw new CliError(`launchctl bootstrap failed: ${stderr}`);
    }

    console.log(`Registered: ${SERVICE_LABEL} (interval: 3600s)`);
  },
});

export default register;
