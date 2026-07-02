// Forward-proxy (HTTP CONNECT + selective MITM) transport.
//
// Why: cache-fix's normal transport points Claude Code at the proxy via
// ANTHROPIC_BASE_URL. On Claude Code >= 2.1.196 a non-Anthropic base URL
// disables Remote Control (RC). This transport instead sits in front of the
// REAL api.anthropic.com as an HTTPS_PROXY: CC's base URL stays
// api.anthropic.com, so RC keeps working, while we still see and transform
// /v1/messages.
//
// It only MITMs the upstream host (api.anthropic.com), where the cacheable
// /v1/messages traffic lives, and blind-tunnels every other CONNECT
// (mcp-proxy.anthropic.com, telegram, npm, ...) untouched, so RC/MCP and
// unrelated traffic are unaffected. The decrypted upstream request is fed into
// the SAME http request handler used by reverse-proxy mode (server.emit
// ('connection', tlsSocket)), so the entire extension pipeline is reused as-is.
//
// Client wiring (ANTHROPIC_BASE_URL stays UNSET):
//   HTTPS_PROXY=http://127.0.0.1:<port>  NODE_EXTRA_CA_CERTS=<caPath>  claude
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import config from "./config.mjs";

// The CA is global (one cert CC trusts), not per-account, so it lives outside
// CLAUDE_CONFIG_DIR. Overridable for tests / non-default homes.
const CA_DIR = process.env.CACHE_FIX_CA_DIR || join(homedir(), ".claude", "cache-fix-ca");

function upstreamHost() {
  try { return new URL(config.upstream).hostname; } catch { return "api.anthropic.com"; }
}

/**
 * Ensure a CA + leaf cert for the upstream host exist (generated once via
 * openssl). Idempotent. Returns { caPath, key, cert } for TLS termination and
 * the CA path the client must trust via NODE_EXTRA_CA_CERTS.
 */
export function ensureCA() {
  const caPem = join(CA_DIR, "ca.pem");
  const caKey = join(CA_DIR, "ca.key");
  const leafPem = join(CA_DIR, "leaf.pem");
  const leafKey = join(CA_DIR, "leaf.key");
  const host = upstreamHost();
  if (existsSync(caPem) && existsSync(leafPem) && existsSync(leafKey)) {
    return { caPath: caPem, key: readFileSync(leafKey), cert: readFileSync(leafPem) };
  }
  mkdirSync(CA_DIR, { recursive: true, mode: 0o700 });
  const run = (args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caPem,
       "-days", "3650", "-subj", "/CN=cache-fix forward-proxy CA"]);
  run(["genrsa", "-out", leafKey, "2048"]);
  const csr = join(CA_DIR, "leaf.csr");
  run(["req", "-new", "-key", leafKey, "-out", csr, "-subj", `/CN=${host}`]);
  const ext = join(CA_DIR, "leaf.ext");
  writeFileSync(ext, `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\n`);
  run(["x509", "-req", "-in", csr, "-CA", caPem, "-CAkey", caKey, "-CAcreateserial",
       "-out", leafPem, "-days", "3650", "-extfile", ext]);
  return { caPath: caPem, key: readFileSync(leafKey), cert: readFileSync(leafPem) };
}

// Parse an http(s)://host:port proxy URL into { host, port }.
function parseProxy(url) {
  if (!url) return null;
  try { const u = new URL(url); return { host: u.hostname, port: Number(u.port) || 80 }; }
  catch { return null; }
}

// Blind-tunnel a CONNECT to `target` (host:port) untouched. Routes through the
// outbound proxy (config.httpsProxy, e.g. corporate/privoxy) when set, else
// dials the target directly. No TLS termination; bytes pass through opaque.
function blindTunnel(target, clientSocket, head) {
  const [host, portStr] = target.split(":");
  const port = Number(portStr) || 443;
  const via = parseProxy(config.httpsProxy);
  const onUpstream = (upstream) => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    const bail = () => { upstream.destroy(); clientSocket.destroy(); };
    upstream.on("error", bail);
    clientSocket.on("error", bail);
  };
  if (via) {
    // CONNECT target through the outbound proxy.
    const r = http.request({ host: via.host, port: via.port, method: "CONNECT", path: target,
                             headers: { host: target } });
    r.on("connect", (_res, socket) => onUpstream(socket));
    r.on("error", () => clientSocket.destroy());
    r.end();
  } else {
    const socket = net.connect(port, host, () => onUpstream(socket));
    socket.on("error", () => clientSocket.destroy());
  }
}

/**
 * Attach the forward-proxy CONNECT handler to an existing http.Server (the one
 * returned by createProxyServer()). MITMs the upstream host and feeds the
 * decrypted stream back into `server`'s own request handler; blind-tunnels the
 * rest. Returns the CA path (for NODE_EXTRA_CA_CERTS).
 */
export function attachForwardProxy(server) {
  const { caPath, key, cert } = ensureCA();
  const secureContext = tls.createSecureContext({ key, cert });
  const host = upstreamHost();

  server.on("connect", (req, clientSocket, head) => {
    // Wrap the whole handler: a throw in a 'connect' listener escapes to
    // uncaughtException and takes the process down. Self-heal means a single
    // bad CONNECT tears down that one socket, never the proxy. Always attach
    // the client-socket error handler first so a mid-handshake reset can't
    // crash us either.
    clientSocket.on("error", () => {});
    try {
      const target = req.url; // "host:port"
      const reqHost = target.split(":")[0];
      if (reqHost !== host) return blindTunnel(target, clientSocket, head);

      // MITM the upstream host: terminate TLS with our leaf, then hand the
      // decrypted socket to the server's HTTP handler as if it were a plaintext
      // connection. The pipeline + upstream forwarding run exactly as in
      // reverse-proxy mode; upstream egress uses config.upstream (+ config
      // .httpsProxy) via forwardRequest().
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const tlsSocket = new tls.TLSSocket(clientSocket, { isServer: true, secureContext });
      tlsSocket.on("error", () => tlsSocket.destroy());
      server.emit("connection", tlsSocket);
    } catch {
      try { clientSocket.destroy(); } catch {}
    }
  });

  return caPath;
}
