// Two fixtures a NEIGHBOUR must not be able to turn red. node:test runs files
// concurrently, and each file listens on ephemeral ports of its own, so a number
// one case freed or an address one case opened is reachable by a stranger.
// The upstream case injects the stranger; the dead-hop case asserts where it lives.
import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEAD_HOP, sweepTargets, upstreamFixture } from "./proc-helpers.mjs";

const epipeChild = fileURLToPath(new URL("./fixtures/stdio-epipe-child.mjs", import.meta.url));

// A dead hop a stranger can reach is no longer dead: the walk in proxy-hop-fallback
// finds a listener on the address meant as unreachable and "the same chain is
// still unreachable" fails (measured: a squatter listening there 3 s into the
// case). This case never binds the address, since a listener there is the hazard
// itself. It asserts what keeps strangers off it: the port is below every port a
// bind-to-0 can hand out.
it("the dead hop is a port no neighbour's listen(0) can be given", () => {
  const port = Number(new URL(DEAD_HOP).port);
  assert.ok(port > 0 && port < 1024, `${DEAD_HOP} is a port a neighbour's listen(0) can be handed`);
});

// The relayed-path case asks "did the request reach the upstream?" of a log the
// fixture writes. Counting every ACCEPT answered a different question: ten
// connections from elsewhere to its port read as ten dials by the proxy.
it("an upstream fixture records the request that carries its marker, not every connection", async () => {
  const trace = [];
  const up = upstreamFixture("mark-under-test", trace);
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const { port } = up.address();
  try {
    await Promise.all(Array.from({ length: 10 }, () => new Promise((r) => {
      const s = net.connect(port, "127.0.0.1", () => s.end());
      s.on("close", r);
    })));
    assert.deepEqual(trace, [], "connections that sent no request were counted as the proxy's dial");

    // The control: the instrument still sees what it exists to see.
    await new Promise((r) => http.get({ port, host: "127.0.0.1", agent: false, path: "/v1/messages?mark-under-test" },
      (res) => { res.resume(); res.on("end", r); }));
    assert.deepEqual(trace, ["UPSTREAM"], "control: a request carrying the marker was not recorded");
  } finally {
    up.close();
  }
});

// The EPIPE case chose its proxy's port BEFORE the child started: freePort() binds
// 0, reads the number and closes, so a neighbour can take it in between, and the
// proxy's self-heal swallows the EADDRINUSE and exits 0 with nothing printed
// ("child exited early, code=0"). The number a neighbour holds is handed to the
// child here, and it must still come up, on a port it took at bind.
it("the stdio-EPIPE child binds a port of its own, so a number a neighbour holds cannot stop it", async () => {
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(0, "127.0.0.1", r));
  const taken = squatter.address().port;
  const child = spawn(process.execPath, [epipeChild, String(taken)],
    { env: { ...process.env, STDIO_EPIPE_CHILD: "1" }, stdio: ["ignore", "pipe", "ignore"] });
  try {
    const said = await new Promise((res, rej) => {
      child.stdout.once("data", (d) => res(String(d)));
      child.on("close", (c) => rej(new Error(`child exited before it listened, code=${c}`)));
    });
    const port = Number(/^listening (\d+)/.exec(said)?.[1]);
    assert.ok(port > 0 && port !== taken, `the child announced ${JSON.stringify(said)}, not a port of its own`);
  } finally {
    child.kill("SIGKILL");
    squatter.close();
  }
});

// `node --test` collects every .mjs under test/, the EPIPE child included, and runs
// it bare. Bare, its port argument was NaN, which the proxy's self-heal swallowed
// and the file "passed" by exiting; a child that binds a port of its own would
// listen on stdin for ever, which hangs the whole suite (measured: 24 minutes,
// then killed). Run bare, as the collector does, it must do nothing and exit.
it("the stdio-EPIPE child exits at once when node --test collects it as a test file", async () => {
  const child = spawn(process.execPath, [epipeChild], { stdio: ["pipe", "ignore", "ignore"] });
  try {
    const exited = await Promise.race([once(child, "exit").then(() => true),
                                       new Promise((r) => setTimeout(r, 3_000, false))]);
    assert.ok(exited, "the bare fixture is still listening 3 s on: collected by node --test it never ends");
  } finally {
    child.kill("SIGKILL");
  }
});

// "answers 502 when the upstream refuses" needs an upstream that REFUSES. A
// freePort() number is unowned once returned, so a neighbour that takes it turns
// the refusal into a 200. The address is chosen inside the case, so this reads the
// case for the one hop a neighbour cannot be handed.
it("the refusing-upstream case dials the dead hop, not a number freePort() let go", () => {
  const src = readFileSync(new URL("./proxy-server.test.mjs", import.meta.url), "utf8");
  const body = /it\("answers 502 when the upstream refuses[\s\S]*?\} finally/.exec(src)?.[0];
  assert.ok(body, "the 502 case moved, so this no longer guards anything");
  assert.match(body, /CACHE_FIX_PROXY_UPSTREAM = DEAD_HOP;/,
    "the case's upstream is a number freePort() let go, which a neighbour can listen on");
});

// A file's after() sweep SIGHUPs whatever sweepTargets() names on the ports it
// registered, and a number it let go can later be a NEIGHBOUR's: that launcher
// listens there and matches OURS. Three OURS-shaped holders, selected here and
// signalled by nobody: our own child, a child of somebody else's live process (the
// neighbour's shape), and an orphan (the leaked successor the sweep exists for).
it("the after() sweep selects our own child and an orphan on a registered port, never a stranger's", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "ccf-sweep-"));
  mkdirSync(join(dir, "bin"));
  const holder = join(dir, "bin", "holder.mjs");
  writeFileSync(holder, `import net from "node:net";
const s = net.createServer(() => {});
s.listen(0, "127.0.0.1", () => process.stdout.write(s.address().port + " " + process.pid + "\\n"));
s.unref();
setTimeout(() => {}, 60_000);
`);
  const run = `${JSON.stringify(process.execPath)} ${JSON.stringify(holder)}`;
  const pids = [];
  const up = (cmd, args) => new Promise((res) => spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] })
    .stdout.once("data", (d) => { const [port, pid] = String(d).split(" ").map(Number); pids.push(pid); res({ port, pid }); }));
  try {
    const mine = await up(process.execPath, [holder]);
    const stranger = await up("sh", ["-c", `${run}; true`]);
    const orphan = await up("sh", ["-c", `${run} &`]);
    const got = new Set(sweepTargets([mine.port, stranger.port, orphan.port]).map(Number));
    assert.deepEqual(got, new Set([mine.pid, orphan.pid]),
      `selected ${[...got]}; own child ${mine.pid} and orphan ${orphan.pid} belong to the sweep, stranger's ${stranger.pid} does not`);
  } finally {
    for (const p of pids) try { process.kill(p, "SIGKILL"); } catch { }
    rmSync(dir, { recursive: true, force: true });
  }
});

// Every other signal site reads its targets from the same place, so the row above
// covers them only if they all go through sweepTargets(): a case that takes the
// pids on a number straight from onPort signals a neighbour's live launcher once
// the OS recycles the number. Static, because the selection is inline at each site.
it("no test file takes signal targets straight from onPort, only through sweepTargets", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const bad = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && f !== "fixture-neighbours.test.mjs"
    && /\bonPort\b/.test(readFileSync(join(dir, f), "utf8")));
  assert.deepEqual(bad, [], `these select pids on a port without the parent filter: ${bad}`);
});
