#!/usr/bin/env node
// SessionStart hook: give Bash-tool commands CCF's own upstream instead of CCF.
//
// In forward mode the user points HTTPS_PROXY at CCF, and every process the
// session starts inherits it, so a bulk transfer (aws, git, pip, curl) rides
// CCF. This hook appends exports to $CLAUDE_ENV_FILE (sourced before each Bash
// command) that set the six proxy variables to the hop CCF itself forwards to
// (/health https_proxy), or to "" (direct) when CCF has none. See
// docs/hooks/proxy-floor.md.
//
// Usage: proxy-floor.mjs [ccf-port]   (default $CACHE_FIX_PROXY_PORT, else 9801)
//
// Only assignments are written: Claude Code's env-file parser takes nothing
// else. The six keys and the value are a contract shared with other hooks that
// write the same lines, so the result does not depend on hook order.
// Every failure exits 0 and writes nothing; a hook must not fail the session.
import { appendFileSync } from "node:fs";

const KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const { CLAUDE_ENV_FILE: file, CACHE_FIX_CHILD_PROXY } = process.env;
const port = process.argv[2] || process.env.CACHE_FIX_PROXY_PORT || "9801";

const namesCcf = (v) => {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `http://${v}`);
    return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.port === port;
  } catch { return false; }
};

try {
  if (file && CACHE_FIX_CHILD_PROXY !== "keep" && KEYS.some((k) => namesCcf(process.env[k] ?? ""))) {
    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.status === 200 ? r.json() : null));
    if (health) {
      const floor = typeof health.https_proxy === "string" ? health.https_proxy : "";
      const quoted = `'${floor.replaceAll("'", `'\\''`)}'`;
      appendFileSync(file, KEYS.map((k) => `export ${k}=${quoted}\n`).join(""));
    }
  }
} catch { /* fail open */ }
