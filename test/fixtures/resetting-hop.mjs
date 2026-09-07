// A forward (CONNECT) proxy that reproduces a hop dropping a live connection
// instead of answering it -- the shape privoxy->autossh showed on 2026-09-06
// (accept, CONNECT, then RST, no retry, no response). See CCF's
// proxy/upstream.mjs forwardRequest(), which this fixture's own tests exercise
// through --reset-first-connect.
//
// Every CONNECT is relayed byte-for-byte to --forward once accepted. With
// --reset-first-connect, the FIRST CONNECT this process sees is destroyed
// before it is even read (a fresh, pre-handshake reset, no CONNECT reply);
// every CONNECT after that is served normally. With --stall-first-connect,
// the FIRST CONNECT is read and then never answered at all (the hop accepted
// it and went silent — measured 2026-09-07 05:45-05:48Z, 20s of nothing then
// a 0.6s answer); every CONNECT after that is served normally.
//
// Standalone:
//   node test/fixtures/resetting-hop.mjs --listen <port> --forward <host:port> [--reset-first-connect | --stall-first-connect]

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
      if (client.resetAndDestroy) client.resetAndDestroy();
      else client.destroy();
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

function parseArgs(argv) {
  const out = { listen: 0, forward: "", resetFirstConnect: false, stallFirstConnect: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--listen") out.listen = Number(argv[++i]);
    else if (argv[i] === "--forward") out.forward = argv[++i];
    else if (argv[i] === "--reset-first-connect") out.resetFirstConnect = true;
    else if (argv[i] === "--stall-first-connect") out.stallFirstConnect = true;
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.forward) {
    console.error("usage: node test/fixtures/resetting-hop.mjs --listen <port> --forward <host:port> [--reset-first-connect | --stall-first-connect]");
    // Exit 0, not 1: `node --test` discovers every .mjs under test/ (this
    // sibling fixture, test/fixtures/stdio-epipe-child.mjs, is proof — no
    // guard, no args, and it is left to pass by never exiting non-zero). A
    // real CLI misuse still gets the usage line; it just does not also read
    // as a failed test in the whole-suite run.
    process.exit(0);
  }
  const server = startResettingHop(args);
  server.listen(args.listen, "127.0.0.1", () => {
    const { port } = server.address();
    const mode = args.resetFirstConnect ? " (reset-first-connect)"
      : args.stallFirstConnect ? " (stall-first-connect)" : "";
    console.log(`resetting-hop listening on 127.0.0.1:${port} -> ${args.forward}${mode}`);
  });
}
