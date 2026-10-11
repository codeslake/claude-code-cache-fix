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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { exitWithin, withDeadline } from "./child-deadline.mjs";
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
async function wire() {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  const home = tmp("floor-home-");
  Object.assign(process.env, {
    CACHE_FIX_FORWARD_PROXY: "on", CACHE_FIX_CA_DIR: tmp("floor-ca-"), CLAUDE_CONFIG_DIR: home,
  });
  await resolveHop(true);   // the hop is module state: a walk over an empty chain resets the previous case's
  return { home, restore() {
    for (const k of ENV_KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  } };
}
const listenOn = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const read = (home, port) => readFileSync(join(home, "proxy-floor", String(port)), "utf8");
// What is published under a config dir; [] when nothing ever created the directory.
const ls = (home) => { try { return readdirSync(join(home, "proxy-floor")); } catch { return []; } };

test("listen publishes the configured hop before anything has dialled", async () => {
  const hop = net.createServer();
  const hopPort = await listenOn(hop);
  const w = await wire();
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

    assert.deepEqual(ls(w.home), [String(p.port)], "the atomic write left a temp file behind");
  } finally { await p.close(); a.close(); b.close(); w.restore(); }
});

// An empty file says "I dial direct", which is only true of a proxy with nothing
// to dial through. One whose chain is configured and wholly refused is between
// hops, and its next request may well go through one: the answer is unknown.
test("a configured chain with no reachable hop is UNKNOWN (no file), not direct", async () => {
  const w = await wire();
  const dead = `http://127.0.0.1:${await freePort()}`;
  process.env.CACHE_FIX_FALLBACK_PROXIES = dead;
  const p = await startProxy({ port: await freePort(), watch: false });
  try {
    assert.equal(read(w.home, p.port), dead, "the configured candidate is published until something dials");
    assert.equal(await resolveHop(true), "", "every hop refused: the walk falls through");
    assert.deepEqual(ls(w.home), [], "a chain that is configured but unreachable must not publish direct");
  } finally { await p.close(); w.restore(); }
});

test("a configured value that is no usable hop is UNKNOWN, never direct", async () => {
  for (const key of ["CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_FALLBACK_PROXIES"]) {
    for (const bad of ["not a url", "socks5://127.0.0.1:1080"]) {
      const w = await wire();
      process.env[key] = bad;
      const p = await startProxy({ port: await freePort(), watch: false });
      try {
        assert.deepEqual(ls(w.home), [], `${key}=${bad}`);
        await resolveHop(true);
        assert.deepEqual(ls(w.home), [], `${key}=${bad} after a walk`);
      } finally { await p.close(); w.restore(); }
    }
  }
});

// A credential-stripped URL is a different hop: children sent to it get a 407
// from a proxy that wanted the credentials, which is worse than not having
// moved them at all.
test("a hop URL that carries credentials is UNKNOWN, it is never published stripped", async () => {
  const hop = net.createServer();
  const withCreds = `http://user:pw@127.0.0.1:${await listenOn(hop)}`;
  try {
    for (const key of ["CACHE_FIX_UPSTREAM_PROXY", "CACHE_FIX_FALLBACK_PROXIES"]) {
      const w = await wire();
      process.env[key] = withCreds;
      const p = await startProxy({ port: await freePort(), watch: false });
      try {
        assert.deepEqual(ls(w.home), [], `${key}, before anything dials`);
        assert.equal(await resolveHop(true), withCreds, "the hop is live and in use");
        assert.deepEqual(ls(w.home), [], `${key}, once it is the hop in use`);
      } finally { await p.close(); w.restore(); }
    }
  } finally { hop.close(); }
});

// The six variables get ONE value and the HTTPS walk decides it. An http walk
// can land on a different hop (it reads HTTP_PROXY only), and letting it write
// would flip the file between two values as requests alternate.
test("only the HTTPS hop walk updates the floor: an http walk elsewhere leaves it alone", async () => {
  const w = await wire();
  const a = net.createServer(), b = net.createServer();
  const [aUrl, bUrl] = [`http://127.0.0.1:${await listenOn(a)}`, `http://127.0.0.1:${await listenOn(b)}`];
  process.env.HTTPS_PROXY = aUrl;
  process.env.HTTP_PROXY = bUrl;
  const p = await startProxy({ port: await freePort(), watch: false });
  const file = join(w.home, "proxy-floor", String(p.port));
  try {
    assert.equal(await resolveHop(true), aUrl);
    assert.equal(read(w.home, p.port), aUrl);
    const before = statSync(file).ino;
    assert.equal(await resolveHop(false), bUrl, "the http walk lands on a different hop");
    assert.equal(read(w.home, p.port), aUrl, "an http walk rewrote the floor");
    assert.equal(await resolveHop(true), aUrl);
    assert.equal(statSync(file).ino, before, "an http/https alternation rewrote the file");
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
    assert.deepEqual(ls(w.home), []);
  } finally { await p.close(); w.restore(); }
});

test("reverse-only mode writes no floor file", async () => {
  const w = await wire();
  delete process.env.CACHE_FIX_FORWARD_PROXY;
  const p = await startProxy({ port: await freePort(), watch: false });
  try {
    assert.deepEqual(ls(w.home), []);
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
    assert.deepEqual(ls(w.home), []);
    process.env.CACHE_FIX_FALLBACK_PROXIES = `http://127.0.0.1:${await listenOn(hop)}`;
    await resolveHop(true);
    assert.match(read(w.home, p.port), /^http:\/\/127\.0\.0\.1:\d+$/);
    hop.close();
    await resolveHop(true);
    assert.deepEqual(ls(w.home), [], "a hop that went away left a stale floor, or an empty one");
  } finally { await p.close(); hop.close(); w.restore(); }
});

test("a holder's child publishes under the advertised port, not its own ephemeral one", async () => {
  const w = await wire();
  process.env.CACHE_FIX_HELD_PORT = "9951";
  const p = await startProxy({ port: 0, watch: false });
  try {
    assert.deepEqual(ls(w.home), ["9951"]);
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
// otherwise decide the result. `shell: null` leaves SHELL unset.
async function prefix(cmd, env, { shell = shellPath("bash") || "/bin/sh" } = {}) {
  const child = spawn(SCRIPT, [cmd], {
    env: { PATH: process.env.PATH, ...(shell === null ? {} : { SHELL: shell }), ...env }, stdio: ["ignore", "pipe", "inherit"],
  });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  const drained = new Promise((r) => child.stdout.on("close", r));   // "exit" can come before the last chunk
  const code = await exitWithin(child, 15_000, "child-proxy-floor.sh");
  await withDeadline(drained, 5_000, child, "child-proxy-floor.sh stdout to drain");
  return { out, code };
}
// What a proxy leaves for the script: <config dir>/proxy-floor/<port>.
function publish(configDir, port, floor) {
  mkdirSync(join(configDir, "proxy-floor"), { recursive: true });
  writeFileSync(join(configDir, "proxy-floor", String(port)), floor);
}
// A session whose children inherited a proxy on `port`, with a floor dir for it.
function session(port, floor, extra = {}) {
  const home = tmp("floor-cfg-");
  if (floor !== undefined) publish(home, port, floor);
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

// Any local proxy may publish to the directory, and the session and the proxy
// need not share a config dir: CLAUDE_CONFIG_DIR is looked in first, then
// $HOME/.claude.
test("the floor is looked up in CLAUDE_CONFIG_DIR/proxy-floor first, then $HOME/.claude/proxy-floor", async () => {
  const cfg = tmp("floor-cfg-"), home = tmp("floor-home-");
  publish(join(home, ".claude"), 9801, "http://home.example.test:1");
  const env = { HOME: home, HTTPS_PROXY: CCF };
  const got = async (extra) => lines((await prefix(show, { ...env, ...extra })).out).HTTPS_PROXY;
  assert.equal(await got({ CLAUDE_CONFIG_DIR: cfg }), "[http://home.example.test:1]", "config dir has no file: fall back to $HOME/.claude");
  assert.equal(await got({}), "[http://home.example.test:1]", "CLAUDE_CONFIG_DIR unset");
  publish(cfg, 9801, FLOOR);
  assert.equal(await got({ CLAUDE_CONFIG_DIR: cfg }), `[${FLOOR}]`, "the config dir wins when both have a file");
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
  publish(home, 9802, "http://second.example.test:1");
  publish(home, 9803, "http://third.example.test:1");
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

// ---- which shell runs the command ------------------------------------------
//
// Claude Code resolves the shell itself: CLAUDE_CODE_SHELL, then SHELL, each only
// if it names bash or zsh and is executable; else zsh, then bash, from PATH and
// the usual directories. Execing $SHELL as given would run a user's fish, or no
// shell at all when SHELL is unset, where Claude Code would have run bash or zsh.
const dashAsBash = () => {
  const dash = shellPath("dash");
  if (!dash) return null;
  const link = join(tmp("floor-dash-"), "bash");
  symlinkSync(dash, link);
  return link;
};
const shells = { bash: shellPath("bash"), zsh: shellPath("zsh"), dash: dashAsBash() };
const which = `printf '%s' "\${BASH_VERSION:+bash}\${ZSH_VERSION:+zsh}"`;
// An executable that is not a shell: it prints its own name, so a case can tell
// which candidate the script picked without bash or zsh being installed.
function fakeBin(dir, name) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\nprintf '%s' fake-${name}\n`);
  chmodSync(join(dir, name), 0o755);
}
const withPath = (dir) => ({ PATH: `${dir}:${process.env.PATH}` });

test("SHELL that is not bash or zsh (fish, sh, a path that does not exist, unset) still runs bash or zsh", { skip: !(shells.bash || shells.zsh) && "neither bash nor zsh installed" }, async () => {
  for (const shell of ["/usr/bin/fish", "/bin/sh", null]) {
    const { out, code } = await prefix(which, session(9801, FLOOR), { shell });
    assert.match(out, /^(bash|zsh)$/, `SHELL=${shell}`);
    assert.equal(code, 0);
  }
});

test("CLAUDE_CODE_SHELL wins over SHELL, but only when it names bash or zsh and is executable", { skip: !(shells.bash && shells.zsh) && "needs both bash and zsh" }, async () => {
  const { bash, zsh } = shells;
  const got = async (extra, shell) => (await prefix(which, session(9801, FLOOR, extra), { shell })).out;
  assert.equal(await got({ CLAUDE_CODE_SHELL: zsh }, bash), "zsh");
  assert.equal(await got({ CLAUDE_CODE_SHELL: bash }, zsh), "bash");
  assert.equal(await got({ CLAUDE_CODE_SHELL: "/bin/sh" }, zsh), "zsh", "names neither");
  assert.equal(await got({ CLAUDE_CODE_SHELL: "/nonexistent/bash" }, zsh), "zsh", "not executable");
});

test("no usable SHELL: zsh first, then bash; bash first when SHELL names bash", async () => {
  const dir = tmp("floor-bin-");
  fakeBin(dir, "zsh"); fakeBin(dir, "bash");
  const got = async (shell) => (await prefix("ignored", session(9801, FLOOR, withPath(dir)), { shell })).out;
  assert.equal(await got("/usr/bin/fish"), "fake-zsh");
  assert.equal(await got(null), "fake-zsh");
  assert.equal(await got("/nonexistent/bash"), "fake-bash");
});

const usual = ["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"];
const inUsual = [shells.bash, shells.zsh].some((p) => p && usual.some((d) => p.startsWith(`${d}/`)));
test("a PATH that has no bash or zsh still finds one in the usual directories", { skip: !inUsual && "bash and zsh live outside the usual directories" }, async () => {
  const { out } = await prefix(which, session(9801, undefined, { PATH: tmp("floor-empty-") }), { shell: null });
  assert.match(out, /^(bash|zsh)$/);
});

// ---- the command string reaches the shell as ONE argument --------------------
//
// `sh -c -x` is an option cluster, not a command: bash, zsh and dash all take the
// first argument that does not start with a dash as the command string unless
// `--` ends the options. A leading dash in the command must not change that.
const FLOOR_Q = `http://u'ser@h.example.test:1`;   // a quote in the floor must stay one value
// [command, what it prints given the proxy the child sees]
const commands = [
  [`-e 2>/dev/null; printf '[%s]' "$HTTPS_PROXY"`, (seen) => `[${seen}]`],                       // a leading dash
  [`printf '[%s]' 'a'"'"'b' "$(echo sub)" "$HTTPS_PROXY"`, (seen) => `[a'b][sub][${seen}]`],    // quotes, substitution
  [`printf one\nprintf '[%s]' "$HTTPS_PROXY"`, (seen) => `one[${seen}]`],                       // a newline
];
for (const [name, shell] of Object.entries(shells)) {
  test(`${name}: a leading dash, quotes, substitution and a newline reach the shell intact, with and without a floor`,
    { skip: !shell && `${name} not installed` }, async () => {
      for (const [cmd, want] of commands) for (const floor of [FLOOR_Q, undefined]) {
        const { out, code } = await prefix(cmd, session(9801, floor), { shell });
        assert.equal(out, want(floor ?? CCF), `${cmd} (floor=${floor})`);
        assert.equal(code, 0);
      }
    });
}

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
