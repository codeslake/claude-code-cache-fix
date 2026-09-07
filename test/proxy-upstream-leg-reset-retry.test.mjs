// The 2026-09-06 22:17-23:0xZ burst: 311 x "upstream error -> 502", 14 of them
// a TLS/CONNECT reset on a socket that never sent a byte, 44 a singleton
// ECONNRESET on a keep-alive socket the hop had already dropped. One attempt,
// no retry, every time -- and CCF's pool had no idle timeout against privoxy's
// keep-alive-timeout 300, so a socket sat in the free list well past the point
// the hop had already closed it.
//
// Two guards in proxy/upstream.mjs forwardRequest()/buildAgent():
//  (1) retry ONCE, on a fresh dial, when the failure is provably pre-send
//      (nothing written to the wire yet) -- covers both a hop that resets the
//      CONNECT before replying and a reused socket the peer already reset
//      (req.reusedSocket + ECONNRESET, Node's own documented idiom).
//  (2) an Agent idle timeout well under privoxy's 300s, so a keep-alive socket
//      idle that long is destroyed and never handed back out for reuse.
//
// Case 1 goes through test/fixtures/resetting-hop.mjs, a CONNECT-relay stub
// standing in for the privoxy hop; cases 2/3 dial a raw backend directly --
// forwardRequest's retry logic reads the SAME socket/request events whether
// the reset came from the immediate peer or was relayed through a hop several
// legs down, so a direct reset is an equally faithful reproduction of "the hop
// dropped it" from the code under test's point of view.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startResettingHop } from "./fixtures/resetting-hop.mjs";

// This host runs with a REAL proxy wired in ambient env (HTTPS_PROXY etc.,
// carrying live credentials) and NO_PROXY=127.0.0.1 -- left alone, every case
// here either bypasses our own hop fixture (NO_PROXY matches 127.0.0.1) or,
// worse, could dial the live pin. Scrub the whole set every case; only
// CACHE_FIX_UPSTREAM_PROXY (never inherited, see proxy/config.mjs) is ours to set.
const ENV_KEYS = [
  "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_PROXY_UPSTREAM", "CACHE_FIX_PROXY_REJECT_UNAUTHORIZED",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
  "NO_PROXY", "no_proxy",
];
function withEnv(overrides, fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  return Promise.resolve().then(fn).finally(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}

const mockReq = (extraHeaders = {}) => ({
  url: "/v1/messages",
  method: "POST",
  headers: { "content-type": "application/json", ...extraHeaders },
});

describe("upstream leg resets (PR fix/upstream-leg-resets)", () => {
  it("retries once when the hop resets the CONNECT before replying, and the retry lands on a fresh socket", async () => {
    const backend = http.createServer((req, res) => { res.end("backend-ok"); });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const hop = startResettingHop({ forward: `127.0.0.1:${backendPort}`, resetFirstConnect: true });
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const hopPort = hop.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_PROXY: `http://127.0.0.1:${hopPort}`,
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const { statusCode, upstreamRes } = await forwardRequest(mockReq(), "{}", null);
        assert.equal(statusCode, 200, "the retry after the hop's reset did not reach the real backend");
        const chunks = [];
        for await (const c of upstreamRes) chunks.push(c);
        assert.equal(Buffer.concat(chunks).toString(), "backend-ok");
      });
    } finally {
      backend.close();
      hop.close();
    }
  });

  it("retries once on ECONNRESET from a reused keep-alive socket, and the second call succeeds on a fresh one", async () => {
    // A raw server that answers once, then resets the socket right after --
    // the shape of a hop closing an idle keep-alive connection out from under
    // the client's Agent free-list.
    const srv = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (c) => {
        buf += c.toString();
        if (!buf.includes("\r\n\r\n")) return;
        buf = "";
        const body = "ok";
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
        setImmediate(() => (sock.resetAndDestroy ? sock.resetAndDestroy() : sock.destroy()));
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}`,
        // Forces buildAgent's keepAlive-Agent branch (see comment on the
        // branch in proxy/upstream.mjs) so the pool actually reuses a socket
        // to this backend; without a real Agent there is nothing to reuse.
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const r1 = await forwardRequest(mockReq(), "{}", null);
        assert.equal(r1.statusCode, 200);
        for await (const _ of r1.upstreamRes) { /* drain */ }

        // Fired immediately, no delay: the whole point is that the client's
        // free-socket pool has not yet processed the peer's reset.
        const r2 = await forwardRequest(mockReq(), "{}", null);
        assert.equal(r2.statusCode, 200, "the retry after a reused-socket reset did not land");
        for await (const _ of r2.upstreamRes) { /* drain */ }
      });
    } finally {
      srv.close();
    }
  });

  it("does not retry a reset that arrives after the request was sent on a fresh connection", async () => {
    // Accepts the FIRST connection (so it is fully established) and waits for
    // real request bytes before resetting -- a post-send failure, never
    // eligible for the pre-send retry. Any SECOND connection (a wrongly-issued
    // retry would dial one, fresh) is served normally, so a guard that lets
    // this case retry anyway is caught by the response succeeding instead of
    // the single attempt rejecting -- not just by both ending in a 502 either way.
    let seen = 0;
    const srv = net.createServer((sock) => {
      seen += 1;
      if (seen === 1) {
        sock.once("data", () => {
          if (sock.resetAndDestroy) sock.resetAndDestroy(); else sock.destroy();
        });
        return;
      }
      sock.on("data", (c) => {
        if (!c.toString().includes("\r\n\r\n")) return;
        const body = "ok";
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({ CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}` }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        await assert.rejects(forwardRequest(mockReq(), "{}", null));
        assert.equal(seen, 1, "a post-send reset on a fresh connection was retried");
      });
    } finally {
      srv.close();
    }
  });

  it("gives up after exactly one retry when the fresh dial also fails", async () => {
    // Resets EVERY connection before it ever completes -- the original
    // attempt and, if the guard let it through, the retry too. Bounds the
    // damage of a missing "never more than once" check: without it this would
    // retry forever against a hop that never comes back.
    let seen = 0;
    const srv = net.createServer((sock) => {
      seen += 1;
      if (sock.resetAndDestroy) sock.resetAndDestroy(); else sock.destroy();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({ CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}` }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        await assert.rejects(forwardRequest(mockReq(), "{}", null));
        assert.equal(seen, 2, "did not retry exactly once (one original attempt + one retry)");
      });
    } finally {
      srv.close();
    }
  });

  it("does not retry once the caller has already aborted", async () => {
    let seen = 0;
    const srv = net.createServer((sock) => {
      seen += 1;
      if (sock.resetAndDestroy) sock.resetAndDestroy(); else sock.destroy();
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({ CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}` }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(forwardRequest(mockReq(), "{}", controller.signal));
        assert.equal(seen, 1, "retried a fresh-socket failure even though the caller had already aborted");
      });
    } finally {
      srv.close();
    }
  });

  it("destroys an idle keep-alive socket well under privoxy's 300s timeout, so two requests apart use two connections and two close together share one", async () => {
    const srv = net.createServer((sock) => {
      sock.on("data", (c) => {
        if (!c.toString().includes("\r\n\r\n")) return;
        const body = "ok";
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
      });
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}`,
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const mod = await import("../proxy/upstream.mjs");
        mod.__setUpstreamIdleTimeoutMsForTests(150);
        try {
          const call = async () => {
            const r = await mod.forwardRequest(mockReq(), "{}", null);
            for await (const _ of r.upstreamRes) { /* drain */ }
            return r.upstreamConnectionId;
          };
          const idA = await call();
          const idB = await call(); // back-to-back: shares the socket
          assert.equal(idA, idB, "two immediate requests did not share a pooled connection");

          await new Promise((r) => setTimeout(r, 400)); // > the 150ms idle timeout
          const idC = await call();
          assert.notEqual(idB, idC, "an idle socket past the timeout was still reused");
        } finally {
          mod.__setUpstreamIdleTimeoutMsForTests(undefined);
        }
      });
    } finally {
      srv.close();
    }
  });
});
