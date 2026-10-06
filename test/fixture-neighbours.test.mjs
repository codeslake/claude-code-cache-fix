// Two fixtures a NEIGHBOUR must not be able to turn red. node:test runs files
// concurrently, and each file listens on ephemeral ports of its own, so a number
// one case freed or an address one case opened is reachable by a stranger.
// The upstream case injects the stranger; the dead-hop case asserts where it lives.
import { it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
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
