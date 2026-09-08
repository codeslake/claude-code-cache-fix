// waitForHolder() polls a real readiness signal (probeHealth's /health 200),
// so the ceiling is a worst case, never a fixed timer — but the poll itself
// must be THROTTLED, or a holder that never binds spins the loop against a
// closed port for the whole ceiling instead of leaving it CPU to boot in.
//
// Behavioural, not textual: this drives waitForHolder against a probe that
// never comes up and counts ATTEMPTS over a short ceiling. A 100ms throttle
// over a 1s ceiling makes roughly 10 attempts; an unthrottled spin makes
// thousands in the same window.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitForHolder } from "./proc-helpers.mjs";

describe("waitForHolder throttles its poll", () => {
  it("does not spin: attempts stay bounded over the ceiling, and it still returns the last ERR", async () => {
    let attempts = 0;
    // A VARYING body, so returning the FIRST probe result and returning the
    // LAST are distinguishable — a constant body cannot test pass-through-of-last.
    const neverUp = async () => { attempts++; return `ERR:${attempts}`; };
    const body = await waitForHolder(0, { ceilingMs: 1_000, probe: neverUp });
    assert.equal(body, `ERR:${attempts}`);
    assert.ok(attempts >= 2 && attempts < 50,
      `expected a throttled poll (2-49 attempts over 1s) — got ${attempts}, so the loop is either ` +
      `spinning unthrottled or not polling at all`);
  });

  it("defaults ceilingMs to the pre-#369 budget (25s), not #369's 60s", async () => {
    // Mock Date.now() with a fixed step sequence: 0 at "up" computation,
    // 25_000 (the constant itself, not merely past it) at the first loop
    // check — the loop's `Date.now() < up` is strict, so this pins the
    // default at EXACTLY 25_000, not merely "<= 30_000". Infinity on every
    // later check, so a regressed default that is still greater FAILS on
    // probeCalls instead of hanging the loop (and the case) forever.
    const times = [0, 25_000, Infinity];
    let n = -1;
    const origDateNow = Date.now;
    Date.now = () => times[Math.min(++n, times.length - 1)];
    let probeCalls = 0;
    const neverUp = async () => { probeCalls++; return "ERR:refused"; };
    try {
      await waitForHolder(0, { probe: neverUp });
    } finally {
      Date.now = origDateNow;
    }
    assert.equal(probeCalls, 1,
      `expected the 25s default to have already expired at the 25s mark (1 probe call) — ` +
      `got ${probeCalls}, so ceilingMs is not exactly 25_000`);
  });
});
