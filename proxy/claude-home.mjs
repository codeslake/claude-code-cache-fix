import { join } from "node:path";
import { homedir } from "node:os";

// The Claude Code config root. Honors CLAUDE_CONFIG_DIR — Claude Code sets it
// for alternate accounts (e.g. `--act 2` -> ~/.claude-2, `--console` ->
// ~/.claude-console). Without this, every account's proxy state (quota-status,
// usage.jsonl, session-mirrors, snapshots, oauth) is hardcoded to ~/.claude and
// concurrent accounts clobber each other's account.json. Falls back to
// ~/.claude. Read live (not cached) for test isolation, mirroring config.mjs.
export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}
