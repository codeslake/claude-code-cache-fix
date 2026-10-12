// bin/shell-prefix.sh as Claude Code runs it: the command is the one argument,
// and the environment is shaped like the kind of child being started. The
// script reads only variables Claude Code sets per child kind, so each case
// builds exactly that environment and probes what the command can see.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { text } from "node:stream/consumers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exitWithin } from "./child-deadline.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "shell-prefix.sh");
const tmp = mkdtempSync(join(tmpdir(), "shell-prefix-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const SIX = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
const NO_PROXY = "localhost,example.test";
const KEPT = { NO_PROXY, no_proxy: NO_PROXY };
const env = (extra) => ({
  PATH: process.env.PATH, HOME: tmp, ...KEPT,
  ...Object.fromEntries(SIX.map((v) => [v, "http://pin.invalid:1"])), ...extra,
});
// What Claude Code sets: the Bash tool has CLAUDE_PID and no CLAUDE_PROJECT_DIR;
// a hook has both; a stdio MCP server has CLAUDE_PROJECT_DIR and no CLAUDE_PID,
// unless its Claude was itself started by another Claude's Bash tool.
const bashTool = (SHELL, extra) => env({ SHELL, CLAUDE_PID: "4242", ...extra });
const hook = (extra) => env({ SHELL: "/nonexistent/fish", CLAUDE_PROJECT_DIR: "/p", CLAUDE_PID: "4242", ...extra });
const mcp = (extra) => env({ SHELL: "/nonexistent/fish", CLAUDE_PROJECT_DIR: "/p", ...extra });

async function run(e, cmd, cwd) {
  const child = spawn(SCRIPT, [cmd], { env: e, cwd, stdio: ["ignore", "pipe", "pipe"] });
  const [out, err] = [text(child.stdout), text(child.stderr)];
  const code = await exitWithin(child, 15_000, "shell-prefix.sh never exited");
  return { code, pid: child.pid, out: await out, err: await err };
}
const vars = (out) => Object.fromEntries(out.split("\n").flatMap((l) => {
  const m = /^([A-Za-z_]\w*)=(.*)$/.exec(l);
  return m ? [[m[1], m[2]]] : [];
}));
const proxies = (v) => Object.fromEntries(Object.entries(v).filter(([k]) => /_proxy$/i.test(k)));
const which = (sh) => spawnSync("sh", ["-c", `command -v ${sh}`], { encoding: "utf8" }).stdout.trim();
const PROBE = 'env; echo "sh=${ZSH_VERSION:+zsh}${BASH_VERSION:+bash}"';

const zsh = which("zsh");
for (const sh of ["zsh", "bash"]) {
  const path = which(sh);
  test(`Bash tool under ${sh}: six proxy variables unset, NO_PROXY kept, marker exported`,
    { skip: !path && `${sh} not installed` }, async () => {
      const v = vars((await run(bashTool(path), PROBE)).out);
      assert.equal(v.sh, sh);
      assert.deepEqual(proxies(v), KEPT);
      assert.equal(v.SHELL_PREFIX_CLAUDE_PID, "4242");
    });
}

test("Bash tool: a .zshenv that re-exports HTTPS_PROXY is undone",
  { skip: !zsh && "zsh not installed" }, async () => {
    const z = mkdtempSync(join(tmp, "z-"));
    writeFileSync(join(z, ".zshenv"), "export HTTPS_PROXY=http://zenv.invalid ZENV_RAN=1\n");
    const v = vars((await run(bashTool(zsh, { ZDOTDIR: z }), PROBE)).out);
    assert.equal(v.ZENV_RAN, "1", "the .zshenv did not run, so this proves nothing");
    assert.deepEqual(proxies(v), KEPT);
  });

const bash = which("bash");
test("Bash tool: a BASH_ENV file that re-exports HTTPS_PROXY is undone",
  { skip: !bash && "bash not installed" }, async () => {
    const f = join(tmp, "bash-env");
    writeFileSync(f, "export HTTPS_PROXY=http://benv.invalid BENV_RAN=1\n");
    const v = vars((await run(bashTool(bash, { BASH_ENV: f }), PROBE)).out);
    assert.equal(v.BENV_RAN, "1", "the BASH_ENV file did not run, so this proves nothing");
    assert.deepEqual(proxies(v), KEPT);
  });

for (const [name, extra] of [["top-level", {}], ["nested", { SHELL_PREFIX_CLAUDE_PID: "4141" }]]) {
  test(`hook (${name}): runs under /bin/sh, not $SHELL; six unset, NO_PROXY kept`, async () => {
    const r = await run(hook(extra), `${PROBE}; echo /no-such-dir/*.zz`);
    assert.equal(r.code, 0, r.err); // $SHELL is a missing fish, so using it would give 127
    assert.deepEqual(proxies(vars(r.out)), KEPT);
    assert.match(r.out, /^\/no-such-dir\/\*\.zz$/m); // sh leaves an unmatched glob literal, zsh aborts
  });
}

const q = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const server = join(tmp, "server.mjs");
writeFileSync(server, "console.log(JSON.stringify({ argv: process.argv.slice(2), pid: process.pid, ppid: process.ppid, env: process.env }));\n");
for (const [name, extra] of [["top-level", {}], ["nested", { CLAUDE_PID: "4242", SHELL_PREFIX_CLAUDE_PID: "4242" }]]) {
  test(`stdio MCP (${name}): becomes the server, argv intact, six unset, NO_PROXY kept`, async () => {
    const args = ["a b", "it's", "$HOME;x"];
    const r = await run(mcp(extra), [process.execPath, server, ...args].map(q).join(" "));
    const s = JSON.parse(r.out);
    assert.deepEqual(s.argv, args);
    assert.equal(s.pid, r.pid, "a wrapper process is left in front of the server");
    assert.equal(s.ppid, process.pid);
    assert.deepEqual(proxies(s.env), KEPT);
  });
}

const prev = join(tmp, "prev");
writeFileSync(prev, '#!/bin/sh\necho "PREV-RAN argc=$# arg=$1"\nenv\n', { mode: 0o755 });
writeFileSync(join(tmp, "plain"), "#!/bin/sh\necho PREV-RAN\n", { mode: 0o644 });

test("CACHE_FIX_PREV_SHELL_PREFIX: an absolute executable gets the command as its only argument", async () => {
  const cmd = "echo 'a b'; exit 3";
  const r = await run(bashTool("/bin/sh", { CACHE_FIX_PREV_SHELL_PREFIX: prev }), cmd);
  assert.ok(r.out.includes(`PREV-RAN argc=1 arg=${cmd}\n`), r.out);
  const v = vars(r.out);
  assert.deepEqual(proxies(v), KEPT);
  assert.equal("CACHE_FIX_PREV_SHELL_PREFIX" in v, false, "the variable must be dropped so a chain cannot loop");
});

for (const [what, p] of [["a relative name", "prev"], ["a relative path", "./prev"],
  ["a missing file", join(tmp, "nope")], ["a non-executable", join(tmp, "plain")]]) {
  test(`CACHE_FIX_PREV_SHELL_PREFIX: ${what} is skipped and the command still runs`, async () => {
    const e = bashTool("/bin/sh", { CACHE_FIX_PREV_SHELL_PREFIX: p, PATH: `${tmp}:${process.env.PATH}` });
    assert.equal((await run(e, "echo ran", tmp)).out, "ran\n");
  });
}

for (const [kind, e, cmd] of [["Bash tool", bashTool("/bin/sh"), "exit 7"], ["hook", hook(), "exit 7"],
  ["stdio MCP", mcp(), "sh -c 'exit 7'"]]) {
  test(`${kind}: the command's exit code passes through`, async () => {
    assert.equal((await run(e, cmd)).code, 7);
  });
}
