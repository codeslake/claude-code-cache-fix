// 2026-09-07 05:45:22Z -> ~05:47:50Z: a hop accepted the CONNECT and answered
// nothing for 20s (the leg below it stalled inside a live ssh channel); the
// next try answered in 0.6s. Nothing had gone out yet, so it is exactly the
// pre-send shape fix/upstream-leg-resets already retries for a reset -- the
// gap was that a STALL (no error at all, ever, until the 600s request
// timeout) never surfaced an error to retry on.
//
// forwardRequest() now arms a CONNECT-phase budget (config.upstreamConnectTimeoutMs,
// CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS, default 30s) at request creation and
// clears it on 'connect'/'secureConnect' -- so it can only ever fire pre-send,
// which is exactly the class the existing retry-once guard already covers.
// Never on the wait for a first response byte: that stays on `timeout` (600s).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startResettingHop } from "./fixtures/resetting-hop.mjs";

const ENV_KEYS = [
  "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_PROXY_UPSTREAM", "CACHE_FIX_PROXY_REJECT_UNAUTHORIZED",
  "CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS", "CACHE_FIX_PROXY_TIMEOUT",
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

const mockReq = () => ({
  url: "/v1/messages",
  method: "POST",
  headers: { "content-type": "application/json" },
});

describe("upstream CONNECT-phase budget (PR fix/upstream-leg-resets)", () => {
  it("retries once when the hop accepts the CONNECT and never answers, and the retry lands within ~2x the budget", async () => {
    const backend = http.createServer((req, res) => { res.end("backend-ok"); });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const hop = startResettingHop({ forward: `127.0.0.1:${backendPort}`, stallFirstConnect: true });
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const hopPort = hop.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_PROXY: `http://127.0.0.1:${hopPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "200",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const t0 = Date.now();
        const { statusCode, upstreamRes } = await forwardRequest(mockReq(), "{}", null);
        const took = Date.now() - t0;
        assert.equal(statusCode, 200, "the retry after the hop's silent CONNECT did not reach the real backend");
        assert.ok(took < 400, `retry took ${took}ms, more than ~2x the 200ms budget`);
        for await (const _ of upstreamRes) { /* drain */ }
      });
    } finally {
      backend.close();
      hop.close();
    }
  });

  it("does not cut a stall that happens after the request was sent", async () => {
    // Accepts and completes the CONNECT immediately (so 'connect' fires and
    // the budget timer is cleared), then never answers the relayed request.
    // A connect budget that is still armed post-handshake would wrongly cut
    // this; the request timeout (config.timeout, untouched) is the only
    // thing that may.
    const backend = http.createServer(() => { /* accepts, never responds */ });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const controller = new AbortController();
    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "150",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const pending = forwardRequest(mockReq(), "{}", controller.signal)
          .then(() => "resolved").catch((e) => `rejected:${e.message}`);
        const settled = await Promise.race([
          pending,
          new Promise((r) => setTimeout(() => r("still-pending"), 500)),
        ]);
        assert.equal(settled, "still-pending",
          `a post-connect stall settled early (${settled}) — the connect budget cut a phase it must not touch`);
      });
    } finally {
      controller.abort();   // release the still-open connection so the process can exit
      backend.close();
    }
  });

  it("is off when set to 0", async () => {
    // A silent hop plus a 0 budget: nothing here should fire within this
    // test's window -- "off" falls back to the ordinary request timeout
    // (minutes), not to a short cut. `config.timeout` is read once at module
    // load, not per-request, so there is no env knob left to shrink it here;
    // proving "still pending" past a generous window and then tearing the
    // hop's own sockets down by hand (a stalled hpagent CONNECT sub-request
    // has no handle this file can reach otherwise) is what lets the test
    // finish instead of waiting out that timeout for real.
    const backend = http.createServer((req, res) => { res.end("backend-ok"); });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const hop = startResettingHop({ forward: `127.0.0.1:${backendPort}`, stallFirstConnect: true });
    const hopSockets = new Set();
    hop.on("connection", (s) => { hopSockets.add(s); s.on("close", () => hopSockets.delete(s)); });
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const hopPort = hop.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_PROXY: `http://127.0.0.1:${hopPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const settled = await Promise.race([
          forwardRequest(mockReq(), "{}", null).then(() => "resolved").catch((e) => `rejected:${e.message}`),
          new Promise((r) => setTimeout(() => r("still-pending"), 700)),
        ]);
        assert.equal(settled, "still-pending", `CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS=0 did not disable the budget: ${settled}`);
      });
    } finally {
      for (const s of hopSockets) s.destroy();   // drop the stalled CONNECT so nothing keeps the process alive
      backend.close();
      hop.close();
    }
  });
});
