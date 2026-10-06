import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { triesWithin } from "./proc-helpers.mjs";

// proxy-held-port's "keeps the port and backs off" counts the tries a launcher
// made in 1.2 s. It read them off its own stderr after a fixed sleep, so the
// window was however long the runner took to get round to reading, not 1.2 s.
// Measured in whole-file runs: sibling cases' synchronous lsof calls blocked the
// runner for 3 to 4.6 s straight after the kill, the sleep fired that late, and
// the read came before the pipe was drained, so a correct ladder read 0 tries
// (a vacuous pass) or, once drained, 15 (red on a backoff that was applied).
//
// ITS OWN FILE: the check blocks the runner's loop on purpose, and node runs
// each file in its own process. The launcher is not under test, only the window,
// so a stand-in logs stamped tries on a schedule instead of a real launcher.
const W = 300;
const LADDER = [0, 16, 33, 67, 83, 83, 83, 83, 83, 83, 83, 83];   // the product ladder / 6
const FLAT = Array(400).fill(3);                                   // no backoff at all

async function triesAfterStall(delays) {
  const child = spawn(process.execPath, ["-e",
    `(async () => { for (const d of ${JSON.stringify(delays)}) {
       await new Promise((r) => setTimeout(r, d));
       process.stderr.write("cannot start " + Date.now() + "\\n");
     } })();`], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    while (!err.includes("\n")) await new Promise((r) => setTimeout(r, 5));   // the stand-in is up
    const from = Date.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);   // the runner is blocked for 1 s
    return await triesWithin(() => err, from, W);
  } finally {
    child.kill("SIGKILL");
  }
}

it("judges a backoff by the stand-in's clock, so a late read cannot redden a correct one", async () => {
  const late = await triesAfterStall(LADDER);
  assert.ok(late <= 10, `a correct backoff read after a 1 s runner stall counted ${late} tries in ${W}ms`);
  // The control: with no backoff the same window, read just as late, is still blown through.
  const flat = await triesAfterStall(FLAT);
  assert.ok(flat > 10, `a missing backoff counted only ${flat} tries in ${W}ms, so this check cannot fail`);
});
