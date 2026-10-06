// Two fixtures a NEIGHBOUR must not be able to turn red. node:test runs files
// concurrently, and each file listens on ephemeral ports of its own, so a number
// one case freed or an address one case opened is reachable by a stranger.
// Each case below injects the stranger and asserts the fixture does not care.
import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { DEAD_HOP, upstreamFixture } from "./proc-helpers.mjs";

// A dead hop that a stranger binds is no longer dead: the walk in
// proxy-hop-fallback finds a listener on the address meant as unreachable and
// "the same chain is still unreachable" fails (measured: a squatter listening
// there 3 s into the case). The squatter here is that stranger, and it binds the
// address the way a stranger can.
it("a neighbour listening on the dead hop does not bring it back to life", async (t) => {
  const { hopAlive } = await import("../proxy/upstream.mjs");
  const port = Number(new URL(DEAD_HOP).port);
  const squatter = net.createServer();
  const bound = await new Promise((r) => {
    squatter.once("error", () => r(false));
    squatter.listen(port, "127.0.0.1", () => r(true));
  });
  try {
    // A runner that may bind below 1024 (root, a container with the floor
    // lowered) can squat port 1 itself, but no neighbour ASKS for it.
    if (bound && port < 1024) return t.skip("this runner can bind below 1024");
    assert.equal(await hopAlive(DEAD_HOP), false, `a listener on ${DEAD_HOP} made the dead hop answer`);
  } finally {
    if (bound) await new Promise((r) => squatter.close(r));
  }
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
