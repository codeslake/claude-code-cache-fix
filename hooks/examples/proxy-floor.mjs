#!/usr/bin/env node
// SessionStart hook: Bash-tool commands get CCF's own upstream instead of CCF.
// In forward mode every child of the session inherits HTTPS_PROXY=<CCF>, so bulk
// transfers (aws, git, pip, curl) ride CCF. This appends the six proxy exports to
// $CLAUDE_ENV_FILE (sourced before each Bash command) with the hop CCF itself
// forwards to (/health https_proxy), or "" (direct) when it has none.
// Usage: proxy-floor.mjs [ccf-port]  (default $CACHE_FIX_PROXY_PORT, else 9801)
// Assignments only, never `unset`: Claude Code's env-file parser takes nothing
// else. The six keys and the value are shared with other hooks writing the same
// lines, so hook order does not matter. Every failure exits 0 writing nothing.
// See docs/hooks/proxy-floor.md.
import { appendFileSync } from "node:fs";
import http from "node:http";

const KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const { CLAUDE_ENV_FILE: file, CACHE_FIX_CHILD_PROXY } = process.env;
const port = process.argv[2] || process.env.CACHE_FIX_PROXY_PORT || "9801";

const namesCcf = (v) => {
  try {
    const u = new URL(v); // throws on undefined or a non-URL
    return ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.port === port;
  } catch { return false; }
};

try {
  if (file && CACHE_FIX_CHILD_PROXY !== "keep" && KEYS.some((k) => namesCcf(process.env[k]))) {
    // node:http with agent:false, not fetch: fetch obeys NODE_USE_ENV_PROXY and would send this through CCF.
    const health = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/health`, { agent: false, signal: AbortSignal.timeout(1500) }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("close", () => {
          try { resolve(res.statusCode === 200 && res.complete ? JSON.parse(body) : null); } catch { resolve(null); }
        });
      }).on("error", () => resolve(null));
    });
    if (health) {
      const quoted = `'${(health.https_proxy || "").replaceAll("'", `'\\''`)}'`;
      appendFileSync(file, KEYS.map((k) => `export ${k}=${quoted}\n`).join(""));
    }
  }
} catch { /* fail open */ }
