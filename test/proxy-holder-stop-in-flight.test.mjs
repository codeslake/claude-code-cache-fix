// A private TMPDIR for this file, because the launcher spawned below writes
// under os.tmpdir(). First, so nothing reads one before it is set.
import "./file-tmpdir.mjs";

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cmdOf, freePort as takePort, listeners } from "./proc-helpers.mjs";

// ITS OWN FILE, not tidiness: this case used to sit at the end of
// proxy-holder-handover.test.mjs, serially after that file's ~56s "holder
// handover (SIGUSR2)" describe -- upstream's own cost, not ours to carry.
// node:test runs describes within one file serially but separate FILES in
// parallel, so this case rode the suite's wall-clock as +8.4s no matter how
// cheap it was; moved here it costs max(itself, the rest of the suite)
// instead of a sum. See pr-subjects.md #356 (suite weight debt).

// THE HOLDER DELIBERATELY LEAVES A STANDBY BEHIND, and killing the holder is
// what ARMS it -- that is the standby's whole purpose (bin/gap-relay.mjs), so it
// is not a leak in the relay. It is a leak here: production wants the armed
// standby to keep a real port alive, and a test wants its ephemeral port
// released. Nothing else ends one, so this file has to.
//
// Selected by the standby's OWN declaration of its parent, never by name or age:
// a relay whose ppid no longer matches CACHE_FIX_STANDBY_PARENT has been
// orphaned, and matching that parent against the holders THIS FILE spawned is
// what keeps the sweep off production and off other sessions.
//
// /proc, so linux only. CI runs linux and that is where the guard is exercised;
// on a mac the orphan survives until the OS reclaims it, which is a smaller
// wrong than sweeping by name on a shared box.
const spawnedHolders = new Set();
const reapStandbys = () => {
  let dir;
  try { dir = readdirSync("/proc"); } catch { return; }
  for (const e of dir) {
    if (!/^\d+$/.test(e)) continue;
    let env, argv;
    try {
      argv = readFileSync(`/proc/${e}/cmdline`, "utf8").split("\0");
      env = readFileSync(`/proc/${e}/environ`, "utf8").split("\0");
    } catch { continue; }
    if (!argv.some((a) => a.endsWith("/gap-relay.mjs"))) continue;
    const parent = env.find((v) => v.startsWith("CACHE_FIX_STANDBY_PARENT="))?.slice(25);
    if (!parent || !spawnedHolders.has(Number(parent))) continue;
    try { process.kill(Number(e), "SIGKILL"); } catch {}
  }
};
process.on("exit", reapStandbys);
// Records the pid so the sweep above can scope itself to this file's holders.
const spawnHolder = (...args) => { const h = spawn(...args); spawnedHolders.add(h.pid); return h; };

const launcherPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "claude-via-proxy.mjs");

const probe = (port) => new Promise((res) => {
  const r = http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                     // THE STATUS, not merely a reply. A standby relay carrying
                     // this address answers 503 on purpose, and a fixture that
                     // took any response for "the proxy is up" started measuring
                     // 1.3s before one existed.
                     (s) => { s.resume(); s.on("end", () => res(s.statusCode === 200 ? "ok" : `ERR:${s.statusCode}`)); });
  r.on("error", (e) => res(`ERR:${e.code}`));
  // The timeout must RESOLVE, not merely fire: an unhandled one leaves the
  // request hanging and the sampler stalls on it forever.
  r.on("timeout", () => { r.destroy(); res("ERR:ETIMEDOUT"); });
});

// THE PRODUCTION STOP, WITH SOMETHING IN FLIGHT. Every other holder case here
// signals with nothing owed, so `close()` resolves at once and the case passes
// under ANY budget — a ceiling is never reached and a stall test is never asked.
// That is the gap: the one path an operator actually takes (`systemctl stop`,
// Ctrl-C, a plain kill) has never been measured with a reply in the middle of
// being delivered.
//
// WHAT IT USED TO MEASURE IS NO LONGER MEASURABLE HERE, and the replacement is
// not a weakening. The old form timed how long run-service and the proxy stayed
// ON THE PORT after a stop and required it to be the 5s ceiling rather than the
// drain budget. That clock has collapsed: the holder now settles on the proxy's
// RELEASE announcement instead of on its exit, so the port is free in under a
// second — before the first `lsof` even returns. The while loop never ran, and
// `chunks` was then sampled at the same instant as `before`, so the case died on
// its own premise (2 -> 2) while the reply it was worried about was in fact
// still streaming. Measured directly: 2 -> 158 chunks over the ten seconds after
// the stop, holder gone inside 623 ms, and the only listener left was the
// standby relay, which a stop keeps on purpose.
//
// So this pins the two halves that ARE observable, and together they are
// STRONGER than the old assertion. "the port frees" alone passes on the old code
// too (it freed at 5s); "the reply keeps arriving after it frees" is what the 5s
// ceiling could never do, because cutting the reply is how it got there.
describe("a holder stop with a reply in flight", () => {
  it("frees the port without severing the reply", async () => {
    // Bytes must be MOVING at the moment of the stop. If they were not, a stall
    // test would end the drain too and the case could not tell the arms apart.
    const upstream = http.createServer((q, r) => {
      r.writeHead(200, { "content-type": "text/event-stream" });
      let n = 0;
      const t2 = setInterval(() => { try { r.write(`data: ${++n}\n\n`); } catch {} }, 100);
      r.on("close", () => clearInterval(t2));
      q.resume();
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));

    const port = await takePort();
    const env = { ...process.env, CACHE_FIX_PROXY_PORT: String(port),
                  CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                     "ALL_PROXY", "all_proxy", "LISTEN_FDS", "LISTEN_PID",
                     "CACHE_FIX_HOLD_PORT", "CACHE_FIX_WATCH_DEPLOY_MS"]) delete env[k];
    const holder = spawnHolder(process.execPath, [launcherPath, "run-service"],
                         { env, stdio: ["ignore", "ignore", "ignore"] });
    let req = null;
    try {
      const up = Date.now() + 25_000;
      let body = await probe(port);
      while (body.startsWith("ERR:") && Date.now() < up) {
        await new Promise((r) => setTimeout(r, 100));
        body = await probe(port);
      }
      assert.equal(body, "ok", "the holder never came up, so nothing was measured");

      let chunks = 0;
      req = http.request(
        { host: "127.0.0.1", port, path: "/v1/messages", method: "POST",
          headers: { "content-type": "application/json" } },
        (res) => { res.on("data", () => chunks++); res.on("error", () => {}); });
      req.on("error", () => {});
      req.end(JSON.stringify({ model: "x", messages: [], stream: true }));

      const flowing = Date.now() + 15_000;
      while (chunks === 0 && Date.now() < flowing) await new Promise((r) => setTimeout(r, 50));
      assert.ok(chunks > 0,
        "premise: bytes must be reaching the client, or this measures a stop with " +
        "nothing owed — which is the case that already exists and cannot fail here");

      const before = chunks;
      const t0 = Date.now();
      holder.kill("SIGTERM");
      // 25s, not a tight bound: what must not happen is the port staying held
      // for a DRAIN budget (90s stall window, 30 minute backstop). Measured, it
      // frees in well under a second, so this is loose on purpose rather than
      // sensitive to how long a spawn takes on a loaded box.
      const stopped = Date.now() + 25_000;
      let left = listeners(port);
      while (Date.now() < stopped
             && left.some((q) => /\brun-service\b|server\.mjs/.test(cmdOf(q)))) {
        await new Promise((r) => setTimeout(r, 200));
        left = listeners(port);
      }
      const elapsed = Date.now() - t0;
      const released = Date.now();
      assert.deepEqual(left.filter((q) => /\brun-service\b|server\.mjs/.test(cmdOf(q))), [],
        `the holder and its proxy were still on the port ${elapsed}ms after SIGTERM — ` +
        `a stop must free the address whatever its child is still finishing`);

      // AND THE REPLY SURVIVED THE STOP THAT FREED THE PORT. This is the half the
      // 5s ceiling could not do: it freed the port by CUTTING what was in flight.
      //
      // GROWTH, NOT TOTAL, AND SAMPLED PAST THE CEILING. `chunks > before` cannot
      // see a cut at all: a 5s ceiling delivers five seconds of bytes first, so
      // the total rises either way. Measured — with the held arm reverted to the
      // ceiling this case still passed, because a 4s sample also lands INSIDE the
      // window it is trying to detect. Two late samples with growth required
      // between them is what separates "still delivering" from "delivered a lot,
      // then was severed".
      //
      // THE FIRST SAMPLE IS A DEADLINE, NOT AN EVENT -- getting past the
      // production 5s ceiling (server.mjs:1907, pinned at test/shutdown-exit-
      // code.test.mjs:1135-1144 -- move the ceiling there and this line's
      // literal has to move too) is just time passing, so it stays a sleep. Timed
      // from `released`, NOT from `t0`: the ceiling's own clock starts inside the
      // proxy (SIGTERM -> holder forwards SIGHUP -> drainStart), `d` ms after t0,
      // and a margin measured from t0 shrinks by exactly `d` -- silently, since a
      // regressed arm would still show growth within ~100ms of a `late` sample
      // taken too early, and PASS. `released` is measured after signal delivery
      // already happened (the port-free loop that produced it polls for the
      // holder's process to leave the port), so counting from there is margin
      // that does not erode with how long the signal takes to land. 2s of
      // headroom over the ceiling matches this file's own measured floor (see
      // test/shutdown-exit-code.test.mjs's UNBIND_PROBE_WAIT_MS note).
      const pastCeiling = released + 5_000 + 2_000 - Date.now();
      if (pastCeiling > 0) await new Promise((r) => setTimeout(r, pastCeiling));
      const late = chunks;
      // THE SECOND SAMPLE'S GROWTH IS AN EVENT -- poll for it instead of paying
      // a fixed sleep no passing run needs (measured: chunks grow every
      // 40-60ms here, so a passing run resolves this in well under 200ms). The
      // 2s ceiling is the same margin as above, reached only when this case is
      // about to fail regardless.
      const grew = Date.now() + 2_000;
      while (chunks <= late && Date.now() < grew) await new Promise((r) => setTimeout(r, 100));
      assert.ok(chunks > before,
        `premise: no byte arrived after the stop at all (${before}), so the drain ` +
        `ended before this could measure anything`);
      assert.ok(chunks > late,
        `the reply stopped at ${late} chunks and never moved again — the stop severed ` +
        `it instead of letting the drainer finish it, which is the ceiling this arm no ` +
        `longer has`);
    } finally {
      try { req?.destroy(); } catch { }
      upstream.close();
      try { holder.kill("SIGKILL"); } catch { }
    }
  });
});
