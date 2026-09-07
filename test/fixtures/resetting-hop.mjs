// A forward (CONNECT) proxy that reproduces a hop dropping a live connection
// instead of answering it -- the shape privoxy->autossh showed on 2026-09-06
// (accept, CONNECT, then RST, no retry, no response). See CCF's
// proxy/upstream.mjs forwardRequest(), which this fixture's own tests exercise
// via resetFirstConnect / stallFirstConnect.
//
// Every CONNECT is relayed byte-for-byte to `forward` once accepted. With
// resetFirstConnect, the FIRST CONNECT this process sees is destroyed before
// it is even read (a fresh, pre-handshake reset, no CONNECT reply); every
// CONNECT after that is served normally. With stallFirstConnect, the FIRST
// CONNECT is read and then never answered at all (the hop accepted it and
// went silent — measured 2026-09-07 05:45-05:48Z, 20s of nothing then a 0.6s
// answer); every CONNECT after that is served normally.
//
// Exports only, no top-level side effects (test/proc-helpers.mjs,
// test/child-deadline.mjs: same convention). Standalone, e.g. (run from the
// repo root):
//   node -e 'import("./test/fixtures/resetting-hop.mjs").then(m => m.startResettingHop({forward:"127.0.0.1:9000",resetFirstConnect:true}).listen(9100,"127.0.0.1",()=>console.log("up")))'
// `stallFirstConnect: true` instead of `resetFirstConnect`, for the silent-CONNECT mode.

import net from "node:net";

export function startResettingHop({ forward, resetFirstConnect = false, stallFirstConnect = false } = {}) {
  const sep = String(forward).lastIndexOf(":");
  const fwdHost = forward.slice(0, sep);
  const fwdPort = Number(forward.slice(sep + 1));
  let seen = 0;

  const server = net.createServer((client) => {
    seen += 1;
    if (resetFirstConnect && seen === 1) {
      // No CONNECT reply, no relay: the request never left this hop.
      client.resetAndDestroy();
      return;
    }

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) return;
      client.removeListener("data", onData);
      const head = buf.slice(0, end).toString();
      const rest = buf.slice(end + 4);
      if (!/^CONNECT /.test(head)) { client.destroy(); return; }

      if (stallFirstConnect && seen === 1) {
        // Accepted and read; never replied, never relayed. Nothing to clean
        // up on close (the caller destroys/aborts its own side).
        return;
      }

      const target = net.connect(fwdPort, fwdHost, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) target.write(rest);
        client.pipe(target);
        target.pipe(client);
      });
      target.on("error", () => client.destroy());
      client.on("error", () => target.destroy());
    };
    client.on("data", onData);
  });
  return server;
}
