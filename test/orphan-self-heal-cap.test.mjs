// EVENT #348. An orphaned proxy/server.mjs (self-heal on) kept spawning a NEW
// `run-service` successor every tick forever, because its guarding
// `setInterval`'s handle was never assigned — nothing could `clearInterval` it,
// so the next tick re-entered and spawned again even while the previous
// successor was still booting or had already died fighting the orphan for the
// port. Measured on <linux-host>: 17 orphaned `run-service` daemons and 85+ orphaned
// `bin/gap-relay.mjs` standbys, some 4-11 days old, 0 connections, owner
// sessions long dead.
//
// Reproduction shape lifted from `armc.sh` (analyzer 1, ledger #348): spawn one
// holder with self-heal ON (CACHE_FIX_SELF_HEAL deleted, the default), let its
// proxy child come up, SIGKILL the holder ONLY, then count how many times the
// orphaned child announces "holder died; started a new one" in a fixed window
// after the kill — analyzer 1 measured 2 in 20s from ONE orphan on a plain
// 1000ms tick. A live successor here does not stay alive long enough to count
// reliably (it loses the immediate port race against the orphan, which keeps
// serving until IT decides a successor is up) — the announcement count is the
// same signal analyzer 1 used and does not depend on that race's outcome.
//
// CACHE_FIX_SELF_HEAL_MS forces the tick down to 50ms — the code's own "test
// seam" comment names this exact knob — so the re-entry window analyzer 1 saw
// naturally at 16s is certain inside this test's budget instead of hoped for.
import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { HOP_ENV, armLineage, freePort, reapStamped } from "./proc-helpers.mjs";

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");

// EVENT #348. See proc-helpers.mjs's armLineage()/reapStamped() and
// proxy-held-port.test.mjs's R3 fix, same shape. armLineage() also installs
// the synchronous exit-time SIGKILL backstop `after()` gets elsewhere — here,
// the case's own `finally` below is async and can be skipped by a crash
// before it runs.
const lineage = armLineage("orphan-cap");

const get = (port) => new Promise((res) => {
  // 200 OR IT IS NOT THE PROXY. A standby relay carrying this address answers
  // /health with a 503 and a JSON body of its own, and readiness on any body
  // lets a loop finish against the relay instead of the real holder.
  const r = http.get({ host: "127.0.0.1", port, path: "/health" }, (q) => {
    let b = ""; q.on("data", (d) => (b += d));
    q.on("end", () => res(q.statusCode === 200 ? b : `ERR:${q.statusCode} ${b.slice(0, 160)}`));
  });
  // `timeout:` in the options only EMITS 'timeout'; it does not destroy the
  // request, so a standby holding an un-armed listen (completes the connect,
  // never answers) leaves this promise unsettled forever.
  r.setTimeout(3_000, () => { r.destroy(); res("ERR:HUNG"); });
  r.on("error", (e) => res(`ERR:${e.code}`));
});

it("announces a self-heal respawn at most once per orphan", async () => {
  const port = await freePort();
  const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port), CACHE_FIX_FORWARD_PROXY: "on",
                CACHE_FIX_SELF_HEAL_MS: "50", CACHE_FIX_TEST_LINEAGE: lineage };
  // Heal ON: no CACHE_FIX_SELF_HEAL in the child's env at all (the default).
  for (const k of [...HOP_ENV, "LISTEN_FDS", "LISTEN_PID", "CACHE_FIX_SELF_HEAL", "CACHE_FIX_WATCH_DEPLOY_MS"])
    delete env[k];
  const holder = spawn(process.execPath, [launcherPath, "run-service"], { env, stdio: ["ignore", "pipe", "pipe"] });
  // The orphan's own self-heal message is written to ITS stderr, which is
  // "inherit" from the launcher that spawned it (proxy/server.mjs's
  // spawnWhenReady), so it arrives on this same pipe even after the holder
  // that started the chain is gone.
  let stderr = "";
  holder.stderr.on("data", (d) => { stderr += d; });
  let kid = 0;
  try {
    const up = Date.now() + 15_000;
    while (Date.now() < up) {
      const body = await get(port);
      if (!body.startsWith("ERR:")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    try { kid = Number(execFileSync("pgrep", ["-P", String(holder.pid)]).toString().trim().split("\n")[0]); } catch {}
    assert.ok(kid > 1, "the holder never spawned a proxy, so this measures nothing");

    holder.kill("SIGKILL");

    // A fixed window past the kill: long enough for several 50ms ticks to
    // fire if the guard is missing, short enough to stay well under the
    // orphan's own 30s exit ceiling so the count is not still climbing when
    // we read it.
    await new Promise((r) => setTimeout(r, 3_000));
    const announcements = (stderr.match(/holder died; started a new one/g) || []).length;
    assert.equal(announcements, 1,
      `expected exactly one self-heal announcement from the orphan, saw ${announcements} ` +
      `in 3s — the self-heal interval is re-firing on every tick instead of stopping after ` +
      `the first successor\nstderr:\n${stderr}`);
  } finally {
    // Reap the whole stamped lineage: the orphaned server (child of the killed
    // holder, which can still be alive waiting out its own exit ceiling), and
    // any successor or standby a tick managed to spawn. `stamped()` finds them
    // by env marker regardless of which port they ended up on or whether they
    // are still fighting over the original one.
    try { holder.kill("SIGKILL"); } catch {}
    if (kid > 1) { try { process.kill(kid, "SIGKILL"); } catch {} }
    await reapStamped(lineage);
  }
});
