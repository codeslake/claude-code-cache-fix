import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exitWithin } from "./child-deadline.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "examples", "proxy-floor.mjs");
const KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const SEED = "# seed\n";
const HOP = "http://proxy.example.test:3128";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

// A stand-in for CCF's /health. Returns { port, close }.
async function fakeHealth(status, body) {
  const srv = http.createServer((q, res) => {
    res.writeHead(q.url === "/health" ? status : 404, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  return { port: await listen(srv), close: () => srv.close() };
}

// Spawns the hook with a temp CLAUDE_ENV_FILE seeded with SEED. `env` is the
// hook's whole environment apart from PATH; `args` is its argv.
async function runHook({ env, args = [], envFile = true }) {
  const dir = mkdtempSync(join(tmpdir(), "pf-"));
  const file = join(dir, "env");
  writeFileSync(file, SEED);
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...(envFile ? { CLAUDE_ENV_FILE: file } : {}), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const code = await exitWithin(child, 6000, "the hook exits");
  const written = readFileSync(file, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { code, out, written };
}

const sixLines = (floor) => KEYS.map((k) => `export ${k}='${floor}'\n`).join("");

test("env names the CCF port: appends six exports carrying CCF's own hop", async () => {
  const h = await fakeHealth(200, { status: "ok", https_proxy: HOP });
  try {
    const r = await runHook({ env: { HTTPS_PROXY: `http://127.0.0.1:${h.port}` }, args: [String(h.port)] });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.equal(r.written, SEED + sixLines(HOP));
  } finally { h.close(); }
});

test("/health https_proxy null: appends six exports of the empty string", async () => {
  const h = await fakeHealth(200, { status: "ok", https_proxy: null });
  try {
    const r = await runHook({ env: { HTTP_PROXY: `http://127.0.0.1:${h.port}` }, args: [String(h.port)] });
    assert.equal(r.code, 0);
    assert.equal(r.written, SEED + sixLines(""));
  } finally { h.close(); }
});

test("the port defaults to CACHE_FIX_PROXY_PORT when no argument is given", async () => {
  const h = await fakeHealth(200, { https_proxy: HOP });
  try {
    const r = await runHook({ env: { ALL_PROXY: `http://127.0.0.1:${h.port}`, CACHE_FIX_PROXY_PORT: String(h.port) } });
    assert.equal(r.written, SEED + sixLines(HOP));
  } finally { h.close(); }
});

// Every key and every loopback spelling counts; the port must match.
for (const [name, host] of [["HTTPS_PROXY", "localhost"], ["https_proxy", "[::1]"], ["HTTP_PROXY", "127.0.0.1"],
  ["http_proxy", "127.0.0.1"], ["ALL_PROXY", "127.0.0.1"], ["all_proxy", "127.0.0.1"]]) {
  test(`${name}=http://${host}:<ccf port> is recognised`, async () => {
    const h = await fakeHealth(200, { https_proxy: HOP });
    try {
      const r = await runHook({ env: { [name]: `http://${host}:${h.port}` }, args: [String(h.port)] });
      assert.equal(r.written, SEED + sixLines(HOP));
    } finally { h.close(); }
  });
}

for (const [label, value] of [["another loopback port", (p) => `http://127.0.0.1:${p + 1}`],
  ["a non-loopback host on the CCF port", (p) => `http://proxy.example.test:${p}`],
  ["a value that is not a URL", () => "not a url"]]) {
  test(`env names ${label}: file untouched`, async () => {
    const h = await fakeHealth(200, { https_proxy: HOP });
    try {
      const r = await runHook({ env: { HTTPS_PROXY: value(h.port) }, args: [String(h.port)] });
      assert.equal(r.code, 0);
      assert.equal(r.written, SEED);
    } finally { h.close(); }
  });
}

test("/health is read directly even when the runtime honours proxy env vars", async () => {
  const h = await fakeHealth(200, { https_proxy: HOP });
  try {
    const ccf = `http://127.0.0.1:${h.port}`;
    const r = await runHook({ env: { HTTP_PROXY: ccf, HTTPS_PROXY: ccf, NODE_USE_ENV_PROXY: "1" }, args: [String(h.port)] });
    assert.equal(r.code, 0);
    assert.equal(r.written, SEED + sixLines(HOP));
  } finally { h.close(); }
});

test("/health unreachable: file untouched, exit 0", async () => {
  const h = await fakeHealth(200, {});
  const { port } = h;
  h.close();
  const r = await runHook({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` }, args: [String(port)] });
  assert.equal(r.code, 0);
  assert.equal(r.written, SEED);
});

for (const [label, answer] of [["never answers", () => {}], ["stops mid-body", (q, res) => { res.writeHead(200); res.write("{"); }]]) {
  test(`/health that ${label}: gives up within the timeout, file untouched`, async () => {
    const srv = http.createServer(answer);
    const port = await listen(srv);
    try {
      const t0 = Date.now();
      const r = await runHook({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` }, args: [String(port)] });
      assert.equal(r.code, 0);
      assert.equal(r.written, SEED);
      assert.ok(Date.now() - t0 < 4000, "hook must not hang the session start");
    } finally { srv.closeAllConnections(); srv.close(); }
  });
}

for (const [label, status, body] of [["non-200", 503, { status: "degraded" }], ["unparseable", 200, "<html>"]]) {
  test(`/health ${label}: file untouched, exit 0`, async () => {
    const h = await fakeHealth(status, body);
    try {
      const r = await runHook({ env: { HTTPS_PROXY: `http://127.0.0.1:${h.port}` }, args: [String(h.port)] });
      assert.equal(r.code, 0);
      assert.equal(r.written, SEED);
    } finally { h.close(); }
  });
}

test("CACHE_FIX_CHILD_PROXY=keep: file untouched", async () => {
  const h = await fakeHealth(200, { https_proxy: HOP });
  try {
    const r = await runHook({
      env: { HTTPS_PROXY: `http://127.0.0.1:${h.port}`, CACHE_FIX_CHILD_PROXY: "keep" }, args: [String(h.port)],
    });
    assert.equal(r.code, 0);
    assert.equal(r.written, SEED);
  } finally { h.close(); }
});

test("CLAUDE_ENV_FILE unset: exit 0, nothing printed", async () => {
  const h = await fakeHealth(200, { https_proxy: HOP });
  try {
    const r = await runHook({ env: { HTTPS_PROXY: `http://127.0.0.1:${h.port}` }, args: [String(h.port)], envFile: false });
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
  } finally { h.close(); }
});

test("end to end: a Bash-tool child that sources the env file sees the hop, not CCF", async (t) => {
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("python3 not available");
  const h = await fakeHealth(200, { https_proxy: HOP });
  const dir = mkdtempSync(join(tmpdir(), "pf-"));
  const file = join(dir, "env");
  try {
    const ccf = `http://127.0.0.1:${h.port}`;
    const r = await runHook({ env: { HTTPS_PROXY: ccf }, args: [String(h.port)] });
    writeFileSync(file, r.written);
    const probe = spawnSync("bash", ["-c",
      `source "${file}"; python3 -c "import urllib.request,json;print(json.dumps(urllib.request.getproxies()))"`],
    { env: { PATH: process.env.PATH, HTTPS_PROXY: ccf, HTTP_PROXY: ccf }, encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const proxies = JSON.parse(probe.stdout);
    assert.equal(proxies.https, HOP);
    assert.equal(proxies.http, HOP);
    assert.ok(!probe.stdout.includes(ccf), probe.stdout);
  } finally { h.close(); rmSync(dir, { recursive: true, force: true }); }
});
