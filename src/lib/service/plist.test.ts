import { describe, expect, test } from "bun:test";
import { generatePlist } from "./plist.ts";
import type { PlistOptions } from "./plist.ts";

describe("plist", () => {
  describe("generatePlist", () => {
    test("generates valid XML plist with StartInterval", () => {
      const options: PlistOptions = {
        label: "com.idea-storage.ai-diary",
        program: "/usr/local/bin/idea-storage",
        programArguments: ["/usr/local/bin/idea-storage", "run"],
        startInterval: 3600,
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
      expect(xml).toContain('<plist version="1.0">');
      expect(xml).toContain("<key>Label</key>");
      expect(xml).toContain("<string>com.idea-storage.ai-diary</string>");
      expect(xml).toContain("<key>StartInterval</key>");
      expect(xml).toContain("<integer>3600</integer>");
      expect(xml).not.toContain("StartCalendarInterval");
    });

    test("generates valid XML plist with StartCalendarInterval", () => {
      const options: PlistOptions = {
        label: "com.idea-storage.user-diary",
        program: "/usr/local/bin/idea-storage",
        startCalendarInterval: { Hour: 0, Minute: 30 },
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      expect(xml).toContain("<key>StartCalendarInterval</key>");
      expect(xml).toContain("<key>Hour</key>");
      expect(xml).toContain("<integer>0</integer>");
      expect(xml).toContain("<key>Minute</key>");
      expect(xml).toContain("<integer>30</integer>");
      expect(xml).not.toContain("StartInterval");
    });

    test("includes ProgramArguments with correct structure", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/bin/bash",
        programArguments: ["/bin/bash", "/path/to/script.sh"],
        startInterval: 60,
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      expect(xml).toContain("<key>ProgramArguments</key>");
      expect(xml).toContain("<array>");
      expect(xml).toContain("<string>/bin/bash</string>");
      expect(xml).toContain("<string>/path/to/script.sh</string>");
      expect(xml).toContain("</array>");
    });

    test("uses program as single ProgramArgument when programArguments is not specified", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/usr/local/bin/my-tool",
        startInterval: 300,
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      expect(xml).toContain("<key>ProgramArguments</key>");
      expect(xml).toContain("<string>/usr/local/bin/my-tool</string>");
    });

    test("includes StandardOutPath and StandardErrorPath", () => {
      const options: PlistOptions = {
        label: "com.idea-storage.test",
        program: "/bin/test",
        startInterval: 60,
        logDir: "/var/log/idea-storage",
      };
      const xml = generatePlist(options);

      expect(xml).toContain("<key>StandardOutPath</key>");
      expect(xml).toContain(
        "<string>/var/log/idea-storage/com.idea-storage.test-stdout.log</string>",
      );
      expect(xml).toContain("<key>StandardErrorPath</key>");
      expect(xml).toContain(
        "<string>/var/log/idea-storage/com.idea-storage.test-stderr.log</string>",
      );
    });

    test("uses stateDir as default logDir", () => {
      const originalEnv = process.env.XDG_STATE_HOME;
      process.env.XDG_STATE_HOME = "/tmp/test-state";
      try {
        const options: PlistOptions = {
          label: "com.test",
          program: "/bin/test",
          startInterval: 60,
        };
        const xml = generatePlist(options);

        expect(xml).toContain("<string>/tmp/test-state/idea-storage/com.test-stdout.log</string>");
        expect(xml).toContain("<string>/tmp/test-state/idea-storage/com.test-stderr.log</string>");
      } finally {
        if (originalEnv !== undefined) {
          process.env.XDG_STATE_HOME = originalEnv;
        } else {
          delete process.env.XDG_STATE_HOME;
        }
      }
    });

    test("does not include KeepAlive", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/bin/test",
        startInterval: 60,
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);
      expect(xml).not.toContain("<key>KeepAlive</key>");
    });

    test("does not include RunAtLoad", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/bin/test",
        startInterval: 60,
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);
      expect(xml).not.toContain("<key>RunAtLoad</key>");
    });

    test("generates well-formed XML structure", () => {
      const options: PlistOptions = {
        label: "com.test.full",
        program: "/bin/bash",
        programArguments: ["/bin/bash", "-c", "echo hello"],
        startCalendarInterval: { Hour: 12, Minute: 0 },
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      // Verify overall structure: starts with XML declaration, ends with closing tags
      expect(xml.trim().startsWith("<?xml")).toBe(true);
      expect(xml.trim().endsWith("</plist>")).toBe(true);
      // The outermost dict should open and close properly
      expect(xml).toContain("<dict>");
      expect(xml).toContain("</dict>");
    });

    test("handles StartCalendarInterval with only Hour", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/bin/test",
        startCalendarInterval: { Hour: 5 },
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      expect(xml).toContain("<key>Hour</key>");
      expect(xml).toContain("<integer>5</integer>");
      expect(xml).not.toContain("<key>Minute</key>");
    });

    test("handles StartCalendarInterval with only Minute", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/bin/test",
        startCalendarInterval: { Minute: 45 },
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      expect(xml).not.toContain("<key>Hour</key>");
      expect(xml).toContain("<key>Minute</key>");
      expect(xml).toContain("<integer>45</integer>");
    });

    test("includes EnvironmentVariables when specified", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/bin/test",
        startInterval: 60,
        logDir: "/tmp/logs",
        environmentVariables: {
          PATH: "/path/to/bin",
          HOME: "/home/user",
        },
      };
      const xml = generatePlist(options);

      expect(xml).toContain("<key>EnvironmentVariables</key>");
      expect(xml).toContain("<key>PATH</key>");
      expect(xml).toContain("<string>/path/to/bin</string>");
      expect(xml).toContain("<key>HOME</key>");
      expect(xml).toContain("<string>/home/user</string>");
    });

    test("does not include EnvironmentVariables when not specified", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/bin/test",
        startInterval: 60,
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      expect(xml).not.toContain("<key>EnvironmentVariables</key>");
    });

    test("includes ExitTimeOut when specified", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/bin/test",
        startInterval: 60,
        exitTimeOut: 3600,
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      expect(xml).toContain("<key>ExitTimeOut</key>");
      expect(xml).toContain("<integer>3600</integer>");
    });

    test("does not include ExitTimeOut when not specified", () => {
      const options: PlistOptions = {
        label: "com.test",
        program: "/bin/test",
        startInterval: 60,
        logDir: "/tmp/logs",
      };
      const xml = generatePlist(options);

      expect(xml).not.toContain("<key>ExitTimeOut</key>");
    });
  });
});
