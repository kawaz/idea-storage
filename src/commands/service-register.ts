import { define } from "gunshi";
import { mkdir } from "node:fs/promises";
import { generatePlist } from "../lib/plist.ts";
import { exitWithError } from "../lib/errors.ts";
import {
  SERVICE_LABEL,
  getLaunchAgentsDir,
  getLaunchdDomain,
  getPlistPath,
  getProgramPath,
} from "../lib/service.ts";

const register = define({
  name: "register",
  description: "Install/update launchd plist and register the service",
  run: async () => {
    const program = await getProgramPath();

    const plist = generatePlist({
      label: SERVICE_LABEL,
      program,
      programArguments: [program, "session", "run"],
      startInterval: 3600,
      exitTimeOut: 3600,
      environmentVariables: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
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
      exitWithError(`launchctl bootstrap failed: ${stderr}`);
    }

    console.log(`Registered: ${SERVICE_LABEL} (interval: 3600s)`);
  },
});

export default register;
