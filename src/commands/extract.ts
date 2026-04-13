import { define } from "gunshi";
import { loadConfig } from "../lib/config.ts";
import { formatConversationToText } from "../lib/conversation.ts";
import { exitWithError } from "../lib/errors.ts";
import { UUID_PATTERN, findSessionFile } from "../lib/session-finder.ts";

const extract = define({
  name: "extract",
  description: "Extract conversation text from a session file",
  args: {
    "max-chars": {
      type: "number",
      description: "Maximum characters (truncates from the beginning, keeping recent)",
    },
  },
  run: async (ctx) => {
    const target = ctx.positionals[ctx.commandPath.length];
    if (!target) {
      exitWithError("Usage: idea-storage extract [--max-chars N] <session-file-or-uuid>");
    }

    let filePath: string;

    if (UUID_PATTERN.test(target)) {
      // UUID: search in claudeDirs
      const config = await loadConfig();
      const found = await findSessionFile(config.claudeDirs, target);
      if (!found) {
        exitWithError(`Session not found: ${target}`);
      }
      filePath = found;
    } else {
      // File path
      filePath = target;
    }

    let text = await formatConversationToText(filePath);

    // Truncate from the beginning if max-chars specified (keep recent)
    const maxChars = ctx.values["max-chars"] as number | undefined;
    if (maxChars !== undefined && text.length > maxChars) {
      text = text.slice(-maxChars);
    }

    process.stdout.write(text);
  },
});

export default extract;
