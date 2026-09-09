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
    // 40s: above the WHOLE nested process's tolerated worst case, not the happy
    // path, and not just the case's own budget — this timeout waits for
    // after() too. The case (proxy-held-port.test.mjs) tolerates 15s to bind
    // (:2386) + 5s relay wait (:2389) + 500ms settle (:2401) = 20.5s, and CI
    // has really exceeded 10s on a boot (:83-84). Its file-level after()
    // (:2410) then runs two more retry loops before it can exit — a port
    // sweep and reapStamped (proc-helpers.mjs:126), each up to 6 * 700ms —
    // adding up to 8.4s more. ~28.9s tolerated end to end.
    const NESTED_CEILING_MS = 40_000;
    const r = spawnSync(process.execPath,
      ["--test", "--test-name-pattern", "leaves a standby for the file-level sweep", testFile],
      { env, encoding: "utf8", timeout: NESTED_CEILING_MS, killSignal: "SIGKILL" });

    // Read before asserting: a leak file the case wrote before a later hang
    // must still reach `lineage`, or the timeout path we're bounding above
    // skips the finally block's reapStamped and orphans the standby for real.
    let pids = [];
    try {
      const [markerLine, pidLine] = readFileSync(leakFile, "utf8").split("\n");
      lineage = markerLine;
      pids = (pidLine || "").trim().split(",").filter(Boolean);
    } catch { }

    assert.ok(!r.error, `the nested run did not complete within ${NESTED_CEILING_MS / 1000}s: ${r.error}`);
    assert.equal(r.status, 0, `the case itself failed:\n${r.stdout}\n${r.stderr}`);
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
