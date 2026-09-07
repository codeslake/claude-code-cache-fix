// EVENT #348, harness for the "leaves a standby for the file-level sweep to
// find" case in proxy-held-port.test.mjs. That case only runs its body under
// LEAK_PROBE_FILE — nothing else in the tree sets it, so this is what does:
// run the file scoped to that one case, wait for the whole process (its
// after() included) to exit, then check every pid it recorded is gone.
import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const testFile = join(dirname(fileURLToPath(import.meta.url)), "proxy-held-port.test.mjs");

it("reaps the standby the lineage sweep in proxy-held-port.test.mjs is meant to catch", () => {
  const dir = mkdtempSync(join(tmpdir(), "leak-probe-"));
  const leakFile = join(dir, "pids");
  try {
    // NODE_TEST_CONTEXT, deleted rather than left to inherit: this harness is
    // itself a test file, so under `node --test test/` a nested `--test` here
    // sees it set and silently declines to run at all ("running recursively"),
    // which would make every assertion below run against an empty leak file.
    const env = { ...process.env, LEAK_PROBE_FILE: leakFile };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath,
      ["--test", "--test-name-pattern", "leaves a standby for the file-level sweep", testFile],
      { env, encoding: "utf8" });
    assert.equal(r.status, 0, `the case itself failed:\n${r.stdout}\n${r.stderr}`);

    let pids = [];
    try { pids = readFileSync(leakFile, "utf8").trim().split(",").filter(Boolean); } catch { }
    assert.ok(pids.length, "the case never recorded a standby pid — this measures nothing");

    for (const pid of pids) {
      let alive = true;
      try { execFileSync("kill", ["-0", pid], { stdio: "ignore" }); } catch { alive = false; }
      assert.equal(alive, false,
        `pid ${pid} (a standby the case leaked on an unregistered port) is still alive after ` +
        `the whole test file exited — the lineage sweep in its after() did not reap it`);
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});
