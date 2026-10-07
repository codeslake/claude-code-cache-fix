// Two fixtures a NEIGHBOUR must not be able to turn red. node:test runs files
// concurrently, and each file listens on ephemeral ports of its own, so a number
// one case freed or an address one case opened is reachable by a stranger.
// The upstream case injects the stranger; the dead-hop case asserts where it lives.
import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEAD_HOP, upstreamFixture } from "./proc-helpers.mjs";

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
  const child = spawn(process.execPath,
    [fileURLToPath(new URL("./fixtures/stdio-epipe-child.mjs", import.meta.url)), String(taken)],
    { stdio: ["ignore", "pipe", "ignore"] });
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
