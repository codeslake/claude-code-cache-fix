// EVENT #348, harness for the "leaves a standby for the file-level sweep to
// find" case in proxy-held-port.test.mjs. That case only runs its body under
// LEAK_PROBE_FILE — nothing else in the tree sets it, so this is what does:
// run the file scoped to that one case, wait for the whole process (its
// after() included) to exit, then check every pid it recorded is gone.
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

import { HOP_ENV, reapStamped, stamped } from "./proc-helpers.mjs";

const testFile = join(dirname(fileURLToPath(import.meta.url)), "proxy-held-port.test.mjs");

it("reaps the standby the lineage sweep in proxy-held-port.test.mjs is meant to catch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leak-probe-"));
  const leakFile = join(dir, "pids");
  let lineage;
  try {
    // NODE_TEST_CONTEXT, deleted rather than left to inherit: this harness is
    // itself a test file, so under `node --test test/` a nested `--test` here
    // sees it set and silently declines to run at all ("running recursively"),
    // which would make every assertion below run against an empty leak file.
    const env = { ...process.env, LEAK_PROBE_FILE: leakFile };
    delete env.NODE_TEST_CONTEXT;
    for (const k of HOP_ENV) delete env[k];
    // 20s: ~20x the loaded single-case wall (~1s, measured at loadavg ~18 on
    // 48 cores) and well under the 56.9s critical-path file
    // (proxy-holder-handover.test.mjs), so a hang here can never become the
    // suite's slowest file.
    const NESTED_CEILING_MS = 20_000;
    const r = spawnSync(process.execPath,
      ["--test", "--test-name-pattern", "leaves a standby for the file-level sweep", testFile],
      { env, encoding: "utf8", timeout: NESTED_CEILING_MS, killSignal: "SIGKILL" });
    assert.ok(!r.error && r.signal !== "SIGKILL",
      `the nested run hit its ${NESTED_CEILING_MS / 1000}s ceiling: ${r.error ?? `killed by ${r.signal}`}`);
    assert.equal(r.status, 0, `the case itself failed:\n${r.stdout}\n${r.stderr}`);

    let pids = [];
    try {
      const [markerLine, pidLine] = readFileSync(leakFile, "utf8").split("\n");
      lineage = markerLine;
      pids = (pidLine || "").trim().split(",").filter(Boolean);
    } catch { }
    assert.ok(lineage && pids.length, "the case never recorded a lineage marker and standby pid — this measures nothing");

    for (const pid of pids) {
      const alive = stamped(lineage).includes(pid);
      assert.equal(alive, false,
        `pid ${pid} (a standby the case leaked on an unregistered port) is still alive after ` +
        `the whole test file exited — the lineage sweep did not reap it`);
    }
  } finally {
    // By marker, never a blind kill on the raw recorded pids: on the red path
    // (the case's own file-level sweep did not run) this is what actually
    // stops the leak from surviving the harness itself, and a recycled pid
    // must still pass the marker+OURS filter before it is worth signalling.
    if (lineage) await reapStamped(lineage);
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});
