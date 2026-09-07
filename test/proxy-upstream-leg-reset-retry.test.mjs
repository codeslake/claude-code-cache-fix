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
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startResettingHop } from "./fixtures/resetting-hop.mjs";

// A throwaway self-signed cert, generated once per case (openssl is already a
// build dependency here — proxy/forward-proxy.mjs shells out to it for the
// real MITM CA). Not that CA machinery: this is a one-off leaf for a local
// TLS test double, nothing this repo's own trust chain touches.
function selfSignedCert() {
  const dir = mkdtempSync(join(tmpdir(), "ccf-connect-budget-cert-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1"]);
  return { dir, key, cert };
}

// config.idleTimeoutMs is read once, at module load (`node --test` isolates
// each file into its own process) -- so a small value for the idle-timeout
// case below has to be set before ANYTHING in this file dynamically imports
// proxy/upstream.mjs for the first time, not scoped to that one test.
process.env.CACHE_FIX_UPSTREAM_IDLE_TIMEOUT_MS = "150";

// An ambient HTTPS_PROXY would route these cases past the fixture; scrub it.
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
        setImmediate(() => sock.resetAndDestroy());
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
          sock.resetAndDestroy();
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
      sock.resetAndDestroy();
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
      sock.resetAndDestroy();
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
        const call = async () => {
          const r = await mod.forwardRequest(mockReq(), "{}", null);
          for await (const _ of r.upstreamRes) { /* drain */ }
          return r.upstreamConnectionId;
        };
        const idA = await call();
        const idB = await call(); // back-to-back: shares the socket
        assert.equal(idA, idB, "two immediate requests did not share a pooled connection");

        await new Promise((r) => setTimeout(r, 400)); // > the 150ms idle timeout (top of file)
        const idC = await call();
        assert.notEqual(idB, idC, "an idle socket past the timeout was still reused");
      });
    } finally {
      srv.close();
    }
  });
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

// fable review, B1: a REUSED (or already-connected) socket never re-fires
// 'connect'/'secureConnect', so `established` stayed false for its whole life
// and the short connect budget — meant only for the CONNECT phase — stayed
// armed through the response wait too. Three shapes hand back such a socket:
// a keep-alive REUSE (any agent), and hpagent's HttpProxyAgent (plain http
// upstream through a hop), whose tunnel socket is already TCP-connected by
// the time it is handed over.
describe("upstream CONNECT-phase budget: already-established sockets (fable review B1)", () => {
  it("re-arms on a REUSED keep-alive socket, so a slow second response is not cut by the connect budget", async () => {
    // HTTPS, not plain http: for a reused socket `!isHTTPS && !sock.connecting`
    // is excluded by construction, so this exercises `upstreamReq.reusedSocket`
    // specifically -- the real-world shape (every /v1/messages call is TLS).
    const { dir, key, cert } = selfSignedCert();
    let seen = 0;
    const backend = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      seen += 1;
      if (seen === 1) { res.end("first"); return; }
      setTimeout(() => res.end("second"), 300);
    });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `https://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "100",
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const r1 = await forwardRequest(mockReq(), "{}", null);
        assert.equal(r1.statusCode, 200);
        for await (const _ of r1.upstreamRes) { /* drain */ }

        // Same connection, reused: today (pre-B1) `established` never becomes
        // true for it, so the 100ms budget — armed as this request's own
        // timeout — stays in effect and cuts the 300ms-delayed response.
        const r2 = await forwardRequest(mockReq(), "{}", null);
        assert.equal(r2.statusCode, 200, "a reused socket's slow response was cut by the connect budget");
      });
    } finally {
      backend.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still re-arms on a genuinely fresh HTTPS connection (control)", async () => {
    const { dir, key, cert } = selfSignedCert();
    const backend = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
      setTimeout(() => res.end("slow-but-real"), 300);
    });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `https://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_CONNECT_TIMEOUT_MS: "100",
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const { statusCode, upstreamRes } = await forwardRequest(mockReq(), "{}", null);
        assert.equal(statusCode, 200, "a fresh HTTPS handshake did not re-arm past the connect budget");
        for await (const _ of upstreamRes) { /* drain */ }
      });
    } finally {
      backend.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not retry a post-send reset relayed through hpagent's HttpProxyAgent (http upstream via a hop)", async () => {
    let seen = 0;
    const backend = net.createServer((sock) => {
      seen += 1;
      sock.once("data", () => { sock.resetAndDestroy(); });
    });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const backendPort = backend.address().port;

    const hop = startResettingHop({ forward: `127.0.0.1:${backendPort}` });   // plain relay, no reset/stall
    await new Promise((r) => hop.listen(0, "127.0.0.1", r));
    const hopPort = hop.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${backendPort}`,
        CACHE_FIX_UPSTREAM_PROXY: `http://127.0.0.1:${hopPort}`,
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        await assert.rejects(forwardRequest(mockReq(), "{}", null));
        assert.equal(seen, 1,
          "a post-send reset relayed through the http-via-hop path was retried — established never became true for its tunnel socket");
      });
    } finally {
      backend.close();
      hop.close();
    }
  });
});

// fable review, B4: the retry dials through the SAME agent/pool, so it can
// land on ANOTHER pooled socket instead of a fresh one -- and when a hop
// drops, every free socket it was carrying tends to die together (the
// 2026-09-06 burst's own shape). One retry against a sibling that is also
// already dead just rejects (isRetry blocks a second try).
describe("upstream leg resets: sibling free sockets (fable review B4)", () => {
  it("destroys sibling free sockets before a retry, so it does not land on another one the same hop dropped", async () => {
    // Resets a socket's SECOND request rather than answering it -- both A and
    // B, once free, carry this same fate, standing in for "the hop dropped
    // every pooled connection together".
    const answered = new WeakSet();
    const backend = net.createServer((sock) => {
      sock.on("data", (chunk) => {
        if (answered.has(sock)) { sock.resetAndDestroy(); return; }
        if (!chunk.toString().includes("\r\n\r\n")) return;
        answered.add(sock);
        const body = "ok";
        sock.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nConnection: keep-alive\r\n\r\n${body}`);
      });
    });
    await new Promise((r) => backend.listen(0, "127.0.0.1", r));
    const port = backend.address().port;

    try {
      await withEnv({
        CACHE_FIX_PROXY_UPSTREAM: `http://127.0.0.1:${port}`,
        CACHE_FIX_PROXY_REJECT_UNAUTHORIZED: "0",
      }, async () => {
        const { forwardRequest } = await import("../proxy/upstream.mjs");
        const call = async () => {
          const r = await forwardRequest(mockReq(), "{}", null);
          for await (const _ of r.upstreamRes) { /* drain */ }
          return r.upstreamConnectionId;
        };
        // Concurrent, not sequential: sequential calls would just reuse ONE
        // socket. Two AT ONCE forces two distinct connections, both free once
        // both finish.
        const [idA, idB] = await Promise.all([call(), call()]);
        assert.notEqual(idA, idB, "premise: two concurrent calls did not open two distinct sockets");

        // Whichever of A/B the pool hands back resets. Without destroying its
        // sibling first, a same-name retry can land on the OTHER one -- which
        // resets too, and (isRetry) is not retried a second time.
        const idC = await call();
        assert.ok(idC !== idA && idC !== idB,
          `the retry reused a sibling free socket (${idC}) instead of dialing fresh`);
      });
    } finally {
      backend.close();
    }
  });
});
