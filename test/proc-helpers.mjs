// Process and port helpers shared by every test file that signals a pid or
// needs an unused port.
//
// One copy, because the four hand-rolled ones cost a test whose entire job was
// to keep them in sync: `no test file signals a pid it knows only by port` in
// suite-collection.test.mjs pinned the OURS expression in each file and checked
// there was exactly one lsof call in each. That guard is deleted with this
// module — a shared definition cannot drift, so there is nothing left to police.
// The drift was already starting: `listeners` was byte-identical in three files
// and an arrow function in a fourth, and freePort had three different shapes.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

// A holder reads the operator's cache-fix-handover.env at every proxy spawn, which can
// re-add keys a fixture deleted (HOP_ENV). Fixtures spread process.env, so pin it here.
process.env.CACHE_FIX_HANDOVER_ENV = join(tmpdir(), "ccf-no-such-handover.env");

// NEVER SIGNAL A PID WE KNOW ONLY BY PORT. freePort() binds 0, reads the number
// and CLOSES, so the OS can hand it to a NEIGHBOURING TEST FILE — node:test runs
// files concurrently and several of them listen in-process. Every caller signals
// or counts what listeners() returns, so an unfiltered answer kills another
// runner: measured, and it is CI run 32087202771.
//
// The predicate is the COMMAND LINE, and it was got wrong twice before landing
// here: matching `node` alone claims every node process on the box, and matching
// a bare filename claims a test file that happens to be named for one of ours.
// A path segment of `bin/` or `proxy/` ending in `.mjs` is what only our
// binaries have — RELATIVE too (`node proxy/server.mjs`, argv[1] with no
// leading `/`), which is why the segment can also start at word start, not
// only after a `/`.
export const OURS = /(?:^|[\s/])(?:bin|proxy)\/[\w.-]+\.mjs\b/;

// The command line of a pid, or "" if it is gone. Every case has to tell a
// holder from a proxy from a standby relay, and they are only distinguishable
// by what they are running.
export const cmdOf = (pid) => {
  try { return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }); }
  catch { return ""; }
};

// Whoever is LISTENING on a port, by port rather than by parentage. The
// self-heal spawns a DETACHED successor, so it is nobody's child and `pgrep -P`
// cannot see it — the only durable handle on it is the address it took.
//
// Filtered HERE and not at the call sites, because it already existed at some of
// them and the rest never got it.
//
// lsof exits 1 on ANY error it hit (a process vanishing mid-scan under load is
// one) and still prints the pids it found, so a throw keeps its stdout.
//
// `port` is one port or an array of them: a sweep over a whole file's ports is ONE
// lsof, since each call costs ~0.5 s here. An empty set returns [] and must not
// reach lsof, which given no port prints every listener on the box.
export function listeners(port) {
  const ports = [port].flat();
  if (!ports.length) return [];
  let out;
  try {
    out = execFileSync("lsof", ["-nP", "-t", `-iTCP@127.0.0.1:${ports.join(",")}`, "-sTCP:LISTEN"],
                       { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) { out = e.stdout ?? ""; }
  return out.trim().split("\n").filter(Boolean).filter((p) => OURS.test(cmdOf(p)));
}

// onPort() over a whole set of ports, for a file's after() sweep: ONE lsof, not one
// per port. Port 0 is a proxy told to pick its own, never a port to sweep, so it is
// dropped, and an empty set must not reach lsof or ours(): `Number([]) === 0` would
// match a proxy that was given port 0.
export const onPorts = (ports) => {
  const ps = ports.filter((p) => Number(p) > 0);
  return ps.length ? [...new Set([...listeners(ps), ...ps.flatMap((p) => ours(p))])] : [];
};

// EVERY FIXTURE ON A PORT, LISTENING OR NOT.
//
// listeners() is `lsof -sTCP:LISTEN`, so it finds a process only while it HOLDS
// THE LISTEN. The standby's whole job is to hand the listen on and keep carrying
// the address, so after a handover it is a live process no sweep can see.
// Measured, two orphans side by side:
//   pid=2404217 ppid=1 port=45855  lsof-sees-it=0   bin/gap-relay.mjs
//   pid=2406768 ppid=1 port=41031  lsof-sees-it=1   bin/gap-relay.mjs
// The invisible ones accumulate — ten at once here, the oldest 788 s, across
// files and runs — and they hold ports and CPU that the NEXT file's readiness
// assertions then time out on. Every "node 20 flake" on this branch has had that
// shape, including a runner found at 414 s with zero CPU, wedged rather than slow.
//
// THE PORT A FIXTURE WAS GIVEN IS IN ITS ENVIRONMENT AND STAYS THERE. That is
// the identifier that survives handing the listen on. Both markers are read
// because the trio does not agree on one: measured on a live trio,
//   claude-via-proxy.mjs  CACHE_FIX_PROXY_PORT=<port>   (no HELD_PORT)
//   gap-relay.mjs         both
//   proxy/server.mjs      CACHE_FIX_HELD_PORT=<port>, PROXY_PORT=0
//
// Still filtered by OURS, for the same reason listeners() is: a port number is
// not ownership, and freePort() hands the same number to neighbouring files.
// EVERY PID WHOSE ENVIRON MATCHES `want`, filtered by OURS, among `pids` when given.
// Shared by ours() (keyed on a registered port), stamped() (keyed on a lineage
// marker) and the sweep's runner tag (keyed on this runner's tag, asked of the pids
// on a port only: a marker on most of the box's fixtures must not be asked of every
// process, each match costs a ps) -- same two platforms, same two markers to read,
// only the regex differs.
export function byEnv(want, pids) {
  const out = [];
  try {
    // Linux: /proc is authoritative and needs no shell-out.
    const all = readdirSync("/proc");
    for (const pid of pids ?? all) {
      if (!/^\d+$/.test(pid)) continue;
      let env = "";
      try { env = readFileSync(`/proc/${pid}/environ`, "utf8").replace(/\0/g, " "); } catch { continue; }
      if (want.test(env) && OURS.test(cmdOf(pid))) out.push(pid);
    }
    return out;
  } catch { /* no /proc: ask ps below */ }
  try {
    // macOS: `ps -wwE` prints the environment after the command. Verified there.
    const rows = execFileSync("ps", ["-wwEo", "pid=,command="],
                              { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of rows.split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (m && (!pids || pids.includes(m[1])) && want.test(m[2]) && OURS.test(m[2])) out.push(m[1]);
    }
  } catch { /* no ps either: the caller falls back to listeners() */ }
  return out;
}

export function ours(port) {
  return byEnv(new RegExp(`CACHE_FIX_(?:HELD|PROXY)_PORT=${Number(port)}(?:\\s|$)`));
}

// EVERY PROCESS DESCENDED FROM ONE TEST FILE'S RUN, by env marker rather than
// by the port it ends up on. onPort()/ours() need a registered port; a
// self-heal successor or a standby relay a case never asked freePort() for
// (born on a kernel-picked port nobody recorded) is still ours to find here,
// because every spawn in this tree forwards `{...process.env, ...}` and so
// inherits whatever the top of the file stamped. Same two platforms as ours();
// unverified on macOS (no live box to measure this leg on) — a case there
// still has the port sweep above as its floor, so nothing regresses.
export function stamped(marker) {
  // Escaped: a marker built from a pid and Date.now() has no regex metachars
  // today, but the marker is a caller-supplied string and `.` alone would
  // silently widen the match to any single character in its place.
  const safe = String(marker).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return byEnv(new RegExp(`CACHE_FIX_TEST_LINEAGE=${safe}(?:\\s|$)`));
}

// SIGHUP, THEN SIGKILL, BY LINEAGE. The shared shape of "reap what this run's
// lineage left behind": SIGHUP is the graceful release a standby only stands
// down on (see bin/claude-via-proxy.mjs's forward()), tried a few times, then
// whatever is still alive gets forced. Two callers had this loop hand-copied;
// one copy is what stays in sync.
export async function reapStamped(marker) {
  for (let i = 0; i < 6; i++) {
    const survivors = stamped(marker);
    if (!survivors.length) break;
    for (const p of survivors) { try { process.kill(Number(p), "SIGHUP"); } catch { /* gone already */ } }
    await new Promise((r) => setTimeout(r, 700));
  }
  for (const p of stamped(marker)) { try { process.kill(Number(p), "SIGKILL"); } catch { /* gone already */ } }
}

// ARM A FILE'S LINEAGE, ONE CALL. `=`, not `||=`: nothing calls this with
// CACHE_FIX_TEST_LINEAGE already set in ITS OWN env (a harness passes a
// marker back through LEAK_PROBE_FILE, never through env), so `||=` here
// would only ever pick up an AMBIENT value the process inherited from
// whatever started it — widening the sweep to a marker this file never
// chose. Installs the synchronous exit-time SIGKILL backstop over it (see the
// note this replaces in proxy-held-port.test.mjs: `after()` is async and can
// be skipped by a crash before teardown) and returns the marker so the
// caller can also `await reapStamped(marker)` from its own async teardown.
export function armLineage(name) {
  const marker = process.env.CACHE_FIX_TEST_LINEAGE = `${name}-${process.pid}`;
  process.on("exit", () => {
    for (const p of stamped(marker)) {
      try { process.kill(Number(p), "SIGKILL"); } catch { /* best effort */ }
    }
  });
  // SIGTERM/SIGINT/SIGHUP have a fatal DEFAULT disposition with no listener
  // attached: the process is torn down by the kernel and the "exit" backstop
  // above never fires. Turning the signal into a normal exit is what lets
  // that backstop run. SIGHUP is how a killed tmux window or a dropped ssh
  // session ends a run here, not just an interactive shell's own hangup.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.once(sig, () => process.exit(128 + osConstants.signals[sig]));
  }
  return marker;
}

// A port nobody is listening on RIGHT NOW. It is released before the caller
// uses it — see the OURS note above for what that costs and how it is bounded.
export async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

// EVERY variable that can give a child an outbound hop, in one list because six
// fixtures scrub it and a per-fixture copy is how one gets missed. It was: five
// of them dropped the four *_PROXY names and none dropped the two CACHE_FIX
// ones, which the relay reads FIRST (bin/gap-relay.mjs) — so a maintainer behind
// a corp proxy ran the suite, the relay carried to it, and its host:port went
// into the 503 body that a failure message now prints. This repo is public and
// that is the hostname-port class its hygiene rule bans.
export const HOP_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
                        "ALL_PROXY", "all_proxy",
                        "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_REQUIRE_HOP",
                        "CACHE_FIX_FALLBACK_PROXIES"];

// THE CLEANUP SET: everything on this port, listening or not. listeners() alone
// misses a standby that has handed its listen on — measured, ten such orphans at
// once, the oldest 788 s, accumulating across files and runs until a later
// file's readiness assertion times out on the CPU and ports they hold. See
// ours() for the mechanism and the two markers it reads.
// Port 0 is the "assign me one" sentinel, never a port anything holds -- and it
// is what a caller's `let port = 0` still carries if it throws before the
// assignment. ours() would then match every proxy child running with
// CACHE_FIX_PROXY_PORT=0, the operator's live one included.
export const onPort = (port) =>
  Number(port) > 0 ? [...new Set([...listeners(port), ...ours(port)])] : [];

// The HTTP health probe every holder-wait fixture used to hand-roll, once. THE
// STATUS is what answers, not merely a reply: a standby relay carrying this
// address answers 503 on purpose, and a fixture that took any response for
// "the proxy is up" started measuring before one existed.
export const probeHealth = (port) => new Promise((res) => {
  const r = http.get({ host: "127.0.0.1", port, path: "/health", agent: false, timeout: 8_000 },
                     (s) => { s.resume(); s.on("end", () => res(s.statusCode === 200 ? "ok" : `ERR:${s.statusCode}`)); });
  r.on("error", (e) => res(`ERR:${e.code}`));
  // The timeout must RESOLVE, not merely fire: an unhandled one leaves the
  // request hanging and the sampler stalls on it forever.
  r.on("timeout", () => { r.destroy(); res("ERR:ETIMEDOUT"); });
});

// Poll probeHealth() for "ok" until the ceiling passes. THROTTLED — the naive
// version re-dials with zero delay between attempts, spinning an http.get
// against a closed port for the whole ceiling instead of giving the holder
// time to bind. 100ms matches the throttle already used by the sibling wait
// in proxy-holder-handover.test.mjs.
export async function waitForHolder(port, { ceilingMs = 25_000, probe = probeHealth } = {}) {
  const up = Date.now() + ceilingMs;
  let body = await probe(port);
  while (body.startsWith("ERR:") && Date.now() < up) {
    await new Promise((r) => setTimeout(r, 100));
    body = await probe(port);
  }
  return body;
}

export const hit = (port) => http.get({ host: "127.0.0.1", port, path: "/health", agent: false });
// "ok", "ERR:<status> <body>", an error code, or "HUNG" once `ms` pass in silence.
export const verdict = (r, ms) => new Promise((res) => {
  r.on("response", (q) => {
    let b = ""; q.on("data", (d) => (b += d));
    q.on("end", () => res(q.statusCode === 200 ? "ok" : `ERR:${q.statusCode} ${b.slice(0, 160)}`));
  });
  // Timers run before the poll phase, so after a runner stall a reply that is
  // already on the socket would read as HUNG. One turn lets it be delivered first.
  r.setTimeout(ms, () => setImmediate(() => { r.destroy(); res("HUNG"); }));
  r.on("error", (e) => res(e.code || "ERR"));
});

// WHAT A FILE'S after() SWEEP MAY SIGNAL on the ports it registered: our own child,
// or anything carrying this runner's lineage tag. freePort() hands a released
// number to a neighbouring file, whose live launcher matches OURS too, and ppid 1
// cannot tell a leaked successor from a neighbour's orphan (init, or a subreaper,
// adopts both). The tag is set at load, so any env that spreads process.env carries
// it down the tree, and it ends in the runner's pid: `sweep-<pid>`, the
// `<name>-<pid>` shape a lineage tag takes wherever else it is set.
process.env.CACHE_FIX_TEST_LINEAGE = `sweep-${process.pid}`;
const ppidOf = (pid) => {
  try { return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()); }
  catch { return 0; }
};
const lineage = new RegExp(`CACHE_FIX_TEST_LINEAGE=\\S*-${process.pid}(?:\\s|$)`);

// A CASE THAT RUNS BESIDE SIBLINGS passes its caseId: the lineage is the runner's, shared
// by every case of the file, so it cannot tell this case's launcher from a sibling's that
// was handed a number this case freed. The caseId is set in the case's own fixtures
// (CACHE_FIX_TEST_CASE, a variable of its own: the lineage tag is matched by name and by
// its `-<pid>` suffix elsewhere) and must match exactly, beside the lineage. The marker
// proves the process is this case's, so no parentage clause: a detached successor of a
// sibling is excluded and this case's own, adopted by init, is not.
export const sweepTargets = (ports, caseId) => {
  const held = onPorts(ports);
  if (caseId !== undefined) {
    return byEnv(new RegExp(`^(?=[\\s\\S]*${lineage.source})(?=[\\s\\S]*CACHE_FIX_TEST_CASE=${caseId}(?:\\s|$))`), held);
  }
  const mine = new Set(byEnv(lineage, held));
  return held.filter((pid) => mine.has(pid) || ppidOf(pid) === process.pid);
};

// THE PER-CASE CLEANUP'S TARGETS: the sweep's orphans, a pid whose parent is outside this
// runner's lineage. A sibling case's live tree is inside it: its launcher is our child,
// its proxy and standby sit under that launcher.
// ponytail: a sibling's detached successor whose parent has exited is adopted by init, as
// ours are, and still passes; the caller that runs beside siblings passes a caseId to
// sweepTargets instead.
export const orphanTargets = (ports) => {
  const held = sweepTargets(ports);
  const ppids = held.map((pid) => String(ppidOf(pid)));
  const live = new Set([String(process.pid), ...byEnv(lineage, ppids)]);
  return held.filter((_, i) => !live.has(ppids[i]));
};

// A HOP THAT STAYS DEAD. A freePort() number is only free until the next asker,
// and a neighbouring file asks constantly, so a case that walks a chain for 2.5 s
// can find a listener on the address it meant as unreachable. Port 1 is not a
// number a neighbour can ask for: every allocator (bind to 0) draws from the
// ephemeral range, which starts at 32768 on Linux and 49152 on macOS and
// Windows, and nothing in this suite binds a fixed low port. Nothing listens
// there either, so a probe is refused at once (5 ms measured), as a closed
// ephemeral port was. (Measured: a case whose dead hop was bound hung where an
// unoccupied one finishes in about four seconds.)
export const DEAD_HOP = "http://127.0.0.1:1";

// A local upstream (418, "teapot") that records into `trace` only a request whose
// URL carries `mark`. Counting every accepted connection read a stranger's
// connect to its ephemeral port as the proxy's dial; only the case's own
// request carries the marker.
export const upstreamFixture = (mark, trace) => http.createServer((q, r) => {
  if (q.url?.includes(mark)) trace.push("UPSTREAM");
  r.writeHead(418); r.end("teapot");
});

// Polls find() every 50 ms until it answers non-null; throws `timedOut` one whole
// sleep after the budget. The deadline is read BEFORE each sleep: a sleep a runner
// stall outlasts ends in the timers phase, ahead of the poll phase that delivers
// what the stall left in the pipe, so reading it after would throw on a stamp
// already there.
export async function pollFor(find, budgetMs, timedOut) {
  const by = Date.now() + budgetMs;
  let expired = false;
  for (;;) {
    const hit = find();
    if (hit != null) return hit;
    if (expired) throw new Error(timedOut);
    expired = Date.now() > by;
    await new Promise((r) => setTimeout(r, 50));
  }
}

// How many "cannot start <ms>" stamps a stand-in logged before `from + windowMs`,
// by ITS clock. A count taken off the stream when the runner gets to it says how
// much the runner had drained, and a runner stalled by a neighbour's synchronous
// lsof drains late or not at all. So wait until a stamp past the window exists
// (everything before it has been delivered) and count only inside it. A stamp
// counts once its newline has arrived: a chunk boundary can cut one short, and
// a cut-off number reads as a smaller one.
export function triesWithin(stderr, from, windowMs, budgetMs = 8_000) {
  const end = from + windowMs;
  return pollFor(() => {
    const stamps = [...stderr().matchAll(/cannot start (\d+)\n/g)].map((m) => Number(m[1]));
    return stamps.some((t) => t >= end) ? stamps.filter((t) => t < end).length : null;
  }, budgetMs, `no try was logged after the ${windowMs}ms window within ${budgetMs}ms: the stand-in stopped respawning`);
}
