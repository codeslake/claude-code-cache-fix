// The child proxy floor: cache-fix publishes the hop it dials through to a file,
// and bin/child-proxy-floor.sh (CLAUDE_CODE_SHELL_PREFIX) hands that hop to every
// process Claude Code starts, instead of cache-fix itself.
//
// Three states, none of them interchangeable:
//   no file    = unknown  (the script changes nothing)
//   empty file = direct   (cache-fix dials out itself, so children do too)
//   a URL      = that hop
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitWithin } from "./child-deadline.mjs";
import { freePort } from "./proc-helpers.mjs";

// Before upstream.mjs loads: it reads the grace window once, at import.
process.env.CACHE_FIX_CHAIN_GRACE_MS = "100";
const { startProxy } = await import("../proxy/server.mjs");
const { resolveHop } = await import("../proxy/upstream.mjs");

const ENV_KEYS = [
  "CACHE_FIX_FORWARD_PROXY", "CACHE_FIX_CA_DIR", "CLAUDE_CONFIG_DIR", "CACHE_FIX_PROXY_UPSTREAM",
  "CACHE_FIX_HTTPS_PROXY", "CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_FALLBACK_PROXIES",
  "CACHE_FIX_HELD_PORT", "CACHE_FIX_REQUIRE_HOP", "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy",
];
const scratch = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d; };
after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// A scrubbed environment with forward mode on and the state dirs in scratch.
async function wire(reset = true) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  const home = tmp("floor-home-");
  Object.assign(process.env, {
    CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_CA_DIR: tmp("floor-ca-"), CLAUDE_CONFIG_DIR: home,
  });
  if (reset) await resolveHop(true);   // lastHop() is module state: an empty chain resets the previous case's hop
  return { home, restore() {
    for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  } };
}
const listenOn = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const read = (home, port) => readFileSync(join(home, `cache-fix-child-proxy-${port}`), "utf8");

// lastHop() is module state, undefined until something dials: this case must run
// first and must not reset it, every later one starts from wire()'s reset.
test("listen publishes the configured hop before anything has dialled", async () => {
  const hop = net.createServer();
  const hopPort = await listenOn(hop);
  const w = await wire(false);
  process.env.CACHE_FIX_FALLBACK_PROXIES = `http://127.0.0.1:${hopPort}`;
  const p = await startProxy({ port: await freePort(), watch: false });
  try {
    assert.equal(read(w.home, p.port), `http://127.0.0.1:${hopPort}`);
  } finally { await p.close(); hop.close(); w.restore(); }
});

test("no hop is an EMPTY file (direct), and the file follows the hop as it changes", async () => {
  const w = await wire();
  const p = await startProxy({ port: await freePort(), watch: false });
  const a = net.createServer(), b = net.createServer();
  const [aPort, bPort] = [await listenOn(a), await listenOn(b)];
  try {
    assert.equal(read(w.home, p.port), "", "no hop configured must publish direct, not leave the file out");

    process.env.CACHE_FIX_FALLBACK_PROXIES = `http://127.0.0.1:${aPort}`;
    assert.equal(await resolveHop(true), `http://127.0.0.1:${aPort}`);
    assert.equal(read(w.home, p.port), `http://127.0.0.1:${aPort}`);

    a.close();
    process.env.CACHE_FIX_FALLBACK_PROXIES = `http://127.0.0.1:${bPort}`;
    assert.equal(await resolveHop(true), `http://127.0.0.1:${bPort}`);
    assert.equal(read(w.home, p.port), `http://127.0.0.1:${bPort}`);

    delete process.env.CACHE_FIX_FALLBACK_PROXIES;
    assert.equal(await resolveHop(true), "");
    assert.equal(read(w.home, p.port), "", "a chain that emptied is direct again");

    assert.deepEqual(readdirSync(w.home), [`cache-fix-child-proxy-${p.port}`], "the atomic write left a temp file behind");
  } finally { await p.close(); a.close(); b.close(); w.restore(); }
});

test("a closed instance stops writing", async () => {
  const w = await wire();
  const p = await startProxy({ port: await freePort(), watch: false });
  const hop = net.createServer();
  const hopPort = await listenOn(hop);
  try {
    await p.close();
    process.env.CACHE_FIX_FALLBACK_PROXIES = `http://127.0.0.1:${hopPort}`;
    await resolveHop(true);
    assert.equal(read(w.home, p.port), "", "a closed instance rewrote a file its successor owns");
  } finally { hop.close(); w.restore(); }
});

// A port the OS picked cannot be in anyone's HTTPS_PROXY ahead of time, so there
// is nothing to look up by it, and a file per ephemeral port would pile up in the
// config dir: every embedded or test start would leave one.
test("an OS-assigned port (0) publishes nothing", async () => {
  const w = await wire();
  const p = await startProxy({ port: 0, watch: false });
  try {
    assert.deepEqual(readdirSync(w.home), []);
  } finally { await p.close(); w.restore(); }
});

test("reverse-only mode writes no floor file", async () => {
  const w = await wire();
  delete process.env.CACHE_FIX_FORWARD_PROXY;
  const p = await startProxy({ port: await freePort(), watch: false });
  try {
    assert.deepEqual(readdirSync(w.home), []);
  } finally { await p.close(); w.restore(); }
});

// CACHE_FIX_REQUIRE_HOP=1 says "never dial direct". An empty floor would send
// every child direct, past the boundary the flag exists to hold, so with no hop
// the answer is unknown: the child keeps this proxy, which refuses.
test("REQUIRE_HOP with no hop publishes nothing, never direct", async () => {
  const w = await wire();
  process.env.CACHE_FIX_REQUIRE_HOP = "1";
  const p = await startProxy({ port: await freePort(), watch: false });
  const hop = net.createServer();
  try {
    assert.deepEqual(readdirSync(w.home), []);
    process.env.CACHE_FIX_FALLBACK_PROXIES = `http://127.0.0.1:${await listenOn(hop)}`;
    await resolveHop(true);
    assert.match(read(w.home, p.port), /^http:\/\/127\.0\.0\.1:\d+$/);
    hop.close();
    await resolveHop(true);
    assert.deepEqual(readdirSync(w.home), [], "a hop that went away left a stale floor, or an empty one");
  } finally { await p.close(); hop.close(); w.restore(); }
});

test("a holder's child publishes under the advertised port, not its own ephemeral one", async () => {
  const w = await wire();
  process.env.CACHE_FIX_HELD_PORT = "9951";
  const p = await startProxy({ port: 0, watch: false });
  try {
    assert.deepEqual(readdirSync(w.home), ["cache-fix-child-proxy-9951"]);
  } finally { await p.close(); w.restore(); }
});

// ---- bin/child-proxy-floor.sh, the CLAUDE_CODE_SHELL_PREFIX script ----------


const SCRIPT = fileURLToPath(new URL("../bin/child-proxy-floor.sh", import.meta.url));
const SIX = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const CCF = "http://127.0.0.1:9801";            // what the session inherits
const FLOOR = "http://hop.example.test:3128";   // what the children should get
const shellPath = (bin) => spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim();

// The prefix is called with one argument, the full command string. The
// environment is built, not inherited: a developer's own HTTPS_PROXY would
// otherwise decide the result.
async function prefix(cmd, env, { shell = "/bin/sh" } = {}) {
  const child = spawn(SCRIPT, [cmd], {
    env: { PATH: process.env.PATH, SHELL: shell, ...env }, stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const code = await exitWithin(child, 15_000, "child-proxy-floor.sh");
  return { out, code };
}
// A session whose children inherited a proxy on `port`, with a floor dir for it.
function session(port, floor, extra = {}) {
  const home = tmp("floor-cfg-");
  if (floor !== undefined) writeFileSync(join(home, `cache-fix-child-proxy-${port}`), floor);
  return { CLAUDE_CONFIG_DIR: home, HTTPS_PROXY: `http://127.0.0.1:${port}`, ...extra };
}
const show = SIX.map((k) => `printf '%s=[%s]\\n' ${k} "\${${k}-unset}"`).join("; ");
const lines = (out) => Object.fromEntries(out.trim().split("\n").map((l) => l.split("=")));
const all = (v) => Object.fromEntries(SIX.map((k) => [k, v]));

test("the script is executable POSIX sh", () => {
  assert.ok(statSync(SCRIPT).mode & 0o111, "not executable");
  assert.match(readFileSync(SCRIPT, "utf8"), /^#!\/bin\/sh\n/);
  assert.equal(spawnSync("/bin/sh", ["-n", SCRIPT]).status, 0);
});

test("a URL file: all six variables become that URL, NO_PROXY is left alone", async () => {
  const { out, code } = await prefix(show + '; printf "NO=[%s]\\n" "$NO_PROXY"',
    session(9801, FLOOR, { NO_PROXY: "keep.example.test" }));
  assert.equal(code, 0);
  assert.deepEqual(lines(out), { ...all(`[${FLOOR}]`), NO: "[keep.example.test]" });
});

test("an EMPTY file: all six are set and empty (direct)", async () => {
  const { out } = await prefix(show, session(9801, ""));
  assert.deepEqual(lines(out), all("[]"));
});

test("NO file: unknown, the command runs unchanged", async () => {
  const { out } = await prefix(show, session(9801, undefined, { ALL_PROXY: CCF }));
  assert.deepEqual(lines(out), { ...all("[unset]"), HTTPS_PROXY: `[${CCF}]`, ALL_PROXY: `[${CCF}]` });
});

test("a file for ANOTHER port, or a non-loopback host, changes nothing", async () => {
  const other = session(9802, FLOOR);                              // file is for 9802, the env names 9801
  assert.equal(lines((await prefix(show, { ...other, HTTPS_PROXY: CCF })).out).HTTPS_PROXY, `[${CCF}]`);
  const remote = session(9801, FLOOR, { HTTPS_PROXY: "http://proxy.example.test:9801" });
  assert.equal(lines((await prefix(show, remote)).out).HTTPS_PROXY, "[http://proxy.example.test:9801]");
});

test("loopback spellings all find the floor", async () => {
  for (const url of ["http://localhost:9801", "http://[::1]:9801", "http://127.0.0.1:9801/", "127.0.0.1:9801",
                      "http://user:pw@127.0.0.1:9801"]) {
    const { out } = await prefix(show, session(9801, FLOOR, { HTTPS_PROXY: url }));
    assert.equal(lines(out).HTTPS_PROXY, `[${FLOOR}]`, url);
  }
});

test("the first variable that names a floor file wins; one without a file is passed over", async () => {
  const home = tmp("floor-cfg-");
  writeFileSync(join(home, "cache-fix-child-proxy-9802"), "http://second.example.test:1");
  writeFileSync(join(home, "cache-fix-child-proxy-9803"), "http://third.example.test:1");
  const env = { CLAUDE_CONFIG_DIR: home, HTTPS_PROXY: "http://127.0.0.1:9801", http_proxy: "http://127.0.0.1:9802",
                ALL_PROXY: "http://127.0.0.1:9803" };
  assert.equal(lines((await prefix(show, env)).out).HTTPS_PROXY, "[http://second.example.test:1]");
});

test("a single quote in the floor stays one value, and nothing in it runs", async () => {
  const evil = `http://u'ser:p@h.example.test:1'; echo INJECTED #`;
  const { out } = await prefix(`printf '%s' "$HTTPS_PROXY"; printf '|%s' "$all_proxy"`, session(9801, evil));
  assert.equal(out, `${evil}|${evil}`);
});

test("the command string and its exit status pass through", async () => {
  const { out, code } = await prefix(`echo "a  b"; exit 7`, session(9801, FLOOR));
  assert.equal(out, "a  b\n");
  assert.equal(code, 7);
  assert.equal((await prefix(`exit 5`, session(9801, undefined))).code, 5);
});

// THE DECISIVE CASE. A shell started with -c reads its own startup file first
// (zsh: .zshenv, every time; bash: $BASH_ENV), and one that exports the proxy
// again would undo a floor set BEFORE the shell started. The script sets the
// floor INSIDE the -c string, after that file ran.
const probe = `python3 -c "import urllib.request as u; print(sorted(u.getproxies().items()))"`;
const needs = (bin) => (shellPath(bin) && shellPath("python3") ? false : `${bin} or python3 not installed`);
// All six: urllib prefers the lowercase names, so exporting only the uppercase ones would not undo a floor.
const reexport = `export ${SIX.map((k) => `${k}=${CCF}`).join(" ")}\n`;

test("zsh: a .zshenv that re-exports the CCF port does not win", { skip: needs("zsh") }, async () => {
  const zdot = tmp("floor-zdot-");
  writeFileSync(join(zdot, ".zshenv"), reexport);
  const shell = shellPath("zsh");
  const { out } = await prefix(probe, session(9801, FLOOR, { ZDOTDIR: zdot, HOME: zdot }), { shell });
  assert.ok(!out.includes("9801"), `the child saw the CCF port: ${out}`);
  assert.match(out, /hop\.example\.test:3128/);
  const direct = await prefix(probe, session(9801, "", { ZDOTDIR: zdot, HOME: zdot }), { shell });
  assert.equal(direct.out.trim(), "[]", "an empty floor must leave getproxies() empty although .zshenv exports the CCF port");
});

test("bash: a BASH_ENV that re-exports the CCF port does not win", { skip: needs("bash") }, async () => {
  const f = join(tmp("floor-bashenv-"), "env.sh");
  writeFileSync(f, reexport);
  const { out } = await prefix(probe, session(9801, FLOOR, { BASH_ENV: f }), { shell: shellPath("bash") });
  assert.ok(!out.includes("9801"), `the child saw the CCF port: ${out}`);
  assert.match(out, /hop\.example\.test:3128/);
});

test("sh: the floor reaches a probe", { skip: needs("sh") }, async () => {
  const { out } = await prefix(probe, session(9801, FLOOR), { shell: "/bin/sh" });
  assert.ok(!out.includes("9801"), `the child saw the CCF port: ${out}`);
  assert.match(out, /hop\.example\.test:3128/);
});

// The two halves agree on the file's name and directory: what the proxy wrote is
// what the script reads, with no hand-made file in between.
test("a running proxy's floor reaches a child through the script", async () => {
  const w = await wire();
  const hop = net.createServer();
  const hopUrl = `http://127.0.0.1:${await listenOn(hop)}`;
  process.env.CACHE_FIX_FALLBACK_PROXIES = hopUrl;
  await resolveHop(true);
  const p = await startProxy({ port: await freePort(), watch: false });
  try {
    const { out } = await prefix(show, { CLAUDE_CONFIG_DIR: w.home, HTTPS_PROXY: `http://127.0.0.1:${p.port}` });
    assert.deepEqual(lines(out), all(`[${hopUrl}]`));
  } finally { await p.close(); hop.close(); w.restore(); }
});
