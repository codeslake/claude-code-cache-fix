import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// cost-report.mjs runs main() at import and does not export lookupRates(), so
// the only way to exercise its rates lookup end-to-end is to run it as a
// subprocess with usage telemetry piped on stdin.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "tools", "cost-report.mjs");

test("prices a claude-opus-5-5 call from the bundled rates.json", () => {
  const usage = JSON.stringify({
    model: "claude-opus-5-5",
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
  }) + "\n";

  const result = spawnSync(process.execPath, [SCRIPT, "--format", "json"], {
    input: usage,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `cost-report exited ${result.status}: ${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.calls[0].cost, 24.2,
    "1M input + 1M output + 1M cache-read at Opus 5.5's own rates (4/20/0.2 $ per MTok)");
});
