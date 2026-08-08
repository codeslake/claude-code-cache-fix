// Does anything get REFUSED on this port while something restarts underneath it?
//
// DEPLOYED, not scratch. This lived in a session's job tmp until 2026-08-08,
// which is swept when the job is deleted — and the one event worth measuring
// (the cswap-pin PyPI release, whose tool-env reinstall is the only thing that
// opens the Darwin handover window) may land in a later session. An instrument
// that has to exist BEFORE a one-shot event cannot live in scratch space. It
// ships beside verify.sh so `deploy.sh` puts it on every machine, because it has
// to run ON the host whose port is moving.
//
// USAGE
//   node .claude/gap-probe.mjs <port> 0 <runMs>          OBSERVE ONLY — signals nothing
//   node .claude/gap-probe.mjs <port> 0 0               OBSERVE UNTIL SIGTERM — no fixed window
//   node .claude/gap-probe.mjs <port> <holderPid> <ms> [SIG]   signals, for lab use
//
// The observe-only form is the one for a live box: pass 0 and it never signals,
// so the restart it measures is whatever the deploy does. Arm it BEFORE the
// event; there is no way to instrument a handover after the fact.
//
// A CONTROL IS BUILT IN AND IS NOT OPTIONAL. Pointed at a port with no listener
// it must report refused == total (measured: 50,840/50,840). Without that,
// `refused: 0` proves nothing — a dialer that cannot see a refusal and a
// handover that never drops one print the identical line.

import http from "node:http";
import { execFile, execFileSync } from "node:child_process";

const port = Number(process.argv[2]);
const holderPid = Number(process.argv[3]);
const runMs = Number(process.argv[4] || 6000);

let ok = 0, refused = 0, reset = 0, other = 0, inflight = 0;
let stop = false;
const otherCodes = new Map();
// WHEN each failure happened, relative to the signal. A count alone cannot say
// whether a reset was the seam or unrelated noise, and "2 resets" is exactly
// the number someone will quote — so record the offset and whether the socket
// had already been answered when it died.
let killAt = 0;
const events = [];
const mark = (kind, res) => events.push({
  kind, msAfterKill: killAt ? Date.now() - killAt : null,
  answered: !!res?.headersSent || !!res?.complete,
});

function dial() {
  if (stop) { if (--inflight === 0) done(); return; }
  const req = http.get(
    { host: "127.0.0.1", port, path: "/health", agent: false, timeout: 4000 },
    (res) => { res.resume(); res.on("end", () => { ok++; dial(); }); },
  );
  req.on("error", (e) => {
    if (e.code === "ECONNREFUSED") { refused++; mark("refused", req.res); }
    else if (e.code === "ECONNRESET") { reset++; mark("reset", req.res); }
    else { other++; otherCodes.set(e.code, (otherCodes.get(e.code) || 0) + 1); mark(e.code, req.res); }
    dial();
  });
  req.on("timeout", () => req.destroy(new Error("timeout")));
}

// WHO HOLDS THE PORT, sampled alongside the dials — because `refused: 0` is not
// a result on its own. A probe stopped before the event it was armed for prints
// exactly the same clean line as a handover that dropped nothing, and on a
// one-shot window there is no second chance to notice which one you got. The
// unbounded mode moved that hazard from a timer to whoever sends SIGTERM; it did
// not remove it.
//
// Identity is (pid, starttime), never pid alone: pid reuse is live on this fleet
// (wraparound measured, pid_max 4194304), and a content hash cannot see a
// restart either — a fresh process on identical bytes publishes the same tree.
const holders = new Set();
let firstHolders = null, lastHolders = null;
const sampleHolders = () => {
  // ASYNC, never execFileSync. The sync version blocked the dial loop while lsof
  // and ps ran — measured 4,206 dials vs 10,852 in the same 1500 ms window, a
  // 2.7x throttle, with the loop stalled ~100 ms at a time. A probe whose whole
  // job is to catch a sub-second gap must not stop dialling to look at who holds
  // the port; the instrument would hide the very window it is armed for.
  execFile("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"], (e, out) => {
    const pids = (out || "").trim().split("\n").filter(Boolean);
    if (!pids.length) { record(""); return; }
    let left = pids.length; const seen = [];
    for (const pid of pids) {
      execFile("ps", ["-o", "lstart=", "-p", pid], (e2, st) => {
        seen.push(`${pid}@${(st || "").trim()}`);
        if (--left === 0) record(seen.sort().join(","));
      });
    }
  });
};
const record = (ids) => {
  if (firstHolders === null) firstHolders = ids;
  lastHolders = ids;
  holders.add(ids);
};

function done() {
  const total = ok + refused + reset + other;
  console.log(JSON.stringify({
    total, ok, refused, reset, other,
    otherCodes: Object.fromEntries(otherCodes),
    // CAPPED. Unbounded, this is one entry per refusal — the dead-port control
    // emits 50,000+ and the JSON was truncated mid-string at 8 KB, so the ONE
    // case this probe exists to report was the case it could not report.
    // Counts are the finding; the array is only for offsets and answered-state.
    failuresRecorded: events.length,
    // THE VERDICT, so a clean count cannot be quoted as a clean handover.
    listenerFirst: firstHolders, listenerLast: lastHolders,
    listenerChanged: holders.size > 1,
    verdict: refused > 0 ? "GAP MEASURED"
           : holders.size > 1 ? "CLEAN HANDOVER MEASURED"
           : "NOTHING HAPPENED — the listener never changed, so this run measures nothing",
    failures: events.slice(0, 20),
  }));
  process.exit(refused === 0 ? 0 : 1);
}

// Four concurrent dialers, so the window is covered densely rather than at
// whatever rate one sequential chain happens to reach.
sampleHolders();
const holderTimer = setInterval(sampleHolders, 500);
holderTimer.unref?.();
inflight = 4;
for (let i = 0; i < 4; i++) dial();

// holderPid 0 = signal nothing. That is the POSITIVE CONTROL: pointed at a port
// with no listener it must report refused == total. Without it, `refused: 0`
// from the real run proves nothing -- a dialer that cannot see a refusal and a
// handover that never drops one produce the identical line, and only the
// control separates them.
if (holderPid > 0) {
  // Fire a third of the way in, so there is a clean before and after.
  setTimeout(() => {
    process.stderr.write(`-> SIG${process.argv[5] || "USR2"} ${holderPid} at ${ok} requests in\n`);
    killAt = Date.now();
    execFileSync("kill", [`-${process.argv[5] || "USR2"}`, String(holderPid)]);
  }, Math.round(runMs / 3));
}

// runMs 0 = RUN UNTIL SIGNALLED, and for a one-shot event that is the only safe
// form. A fixed window is a guess about WHEN the thing happens: the cswap peer
// measured that a pin recycle fires on the next LAUNCHER INVOCATION after an
// install, not when the install returns — so a probe started at install time and
// stopped on a timer can expire BEFORE the event and report `refused: 0` for a
// window that never opened. A clean zero about a window that did not happen is
// the false-GREEN shape, and on a one-attempt event there is no second chance to
// notice. Unbounded, the stop condition lives outside the probe, where whoever
// can actually see the trigger decides.
if (runMs > 0) setTimeout(() => { stop = true; }, runMs);
else for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stop = true; });
