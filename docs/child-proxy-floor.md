# Child proxy floor

**Script:** `bin/child-proxy-floor.sh` (POSIX sh) &nbsp; **Setting:** `CLAUDE_CODE_SHELL_PREFIX`

In [forward-proxy mode](../README.md#forward-proxy-mode-keeps-remote-control-working) you point Claude Code at cache-fix with `HTTPS_PROXY=http://127.0.0.1:<port>`. Claude Code hands its environment to everything the session starts, so every Bash-tool command (`aws`, `git`, `pip`, `curl`), command hook, stdio MCP server and `statusLine` command inherits that proxy too. Bulk transfers then ride cache-fix even though only `api.anthropic.com` needs it.

The floor gives those processes cache-fix's own upstream instead: the corporate proxy cache-fix dials through, or a direct connection when it has none. They never enter cache-fix's port.

## How it works

1. **cache-fix publishes its hop.** In forward-proxy mode, when its HTTPS walk lands on a hop and whenever that hop changes, it writes `<config dir>/proxy-floor/<port>` (`$CLAUDE_CONFIG_DIR`, default `~/.claude`; the directory is created if missing). `<port>` is the port clients put in `HTTPS_PROXY` (the advertised port when a holder runs the proxy; a proxy started on port `0` publishes nothing). The write is atomic (temp file in the same directory, then rename). The content is one line: the scheme and `host:port` of the hop in use (the address `/health` reports as `https_proxy`).

   At listen it starts no walk and writes only an answer that needs none: an empty file when nothing is configured to dial through, and no file when `CACHE_FIX_FALLBACK_PROXIES` holds nothing it can dial, or when `CACHE_FIX_REQUIRE_HOP=1` has nothing configured. With a chain configured it leaves the file as it is (absent, or a predecessor's from a handover) until the first real HTTPS walk, the first `CONNECT` or relayed `https://` request, lands. A walk of its own at listen would claim a dial that was never made: with every hop down it stamps `/health`'s `direct_last` and logs "dialling direct", and it would remove a predecessor's good file during an outage. For the same reason the file is never overwritten by the first configured candidate, which may be the hop that is down. A `CACHE_FIX_UPSTREAM_PROXY` or `HTTPS_PROXY` that is not an `http(s)` URL (a `socks5://` value, say) is walked like any other: the file is removed only when that walk ends, and until then the predecessor's file stays. Until the first request has walked, a fresh install has no file, so commands run unchanged.

   | file | meaning |
   |---|---|
   | absent | unknown. The script changes nothing. |
   | empty | cache-fix has no upstream proxy configured at all, so it dials direct, and children do too. |
   | a URL | that hop. |

   Direct is published **only** when nothing is configured to dial through (no `CACHE_FIX_UPSTREAM_PROXY` or `HTTPS_PROXY`, no `CACHE_FIX_FALLBACK_PROXIES`). Every other case where cache-fix cannot name a hop removes the file, because "unknown" (children keep cache-fix's port, as without the script) is safe where a wrong "direct" or a wrong URL is not:

   - a chain is configured and every hop is unreachable: cache-fix is between hops, not direct;
   - a configured value is not an `http(s)` URL, or does not parse;
   - the hop URL carries credentials (`http://user:pw@host:port`). Published stripped, it would be a different hop that answers children `407`, so it is never published;
   - `CACHE_FIX_REQUIRE_HOP=1` and no hop: direct is forbidden there, so children keep cache-fix, which refuses.

   Only the HTTPS hop walk (the one `CONNECT` tunnels and `https://` relays use) rewrites the file. The six variables get one value, and an `http://` walk that lands on another hop does not flip it.

   **A convention any local proxy may publish to.** One file per listen port, named for the port clients put in `HTTPS_PROXY`, in `<config dir>/proxy-floor/`; the content is the floor as above. Nothing in the directory is specific to cache-fix.

2. **The script reads it.** Claude Code runs every shell command through `CLAUDE_CODE_SHELL_PREFIX`, passing one argument: the full command string. The script looks at `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, `all_proxy` in order. The first one that is a loopback URL (`127.0.0.1`, `localhost`, `[::1]`) whose port has a readable file in `$CLAUDE_CONFIG_DIR/proxy-floor/` (else `~/.claude/proxy-floor/`, for a proxy and a session with different config directories) decides. Every loopback port among the six is tried, so a proxy chained in front of cache-fix that publishes to the same directory is found whichever of the two the variables name. It then runs the command as `<shell> -c -- "export HTTPS_PROXY='<floor>' https_proxy='<floor>' HTTP_PROXY='<floor>' http_proxy='<floor>' ALL_PROXY='<floor>' all_proxy='<floor>'; <command>"`. If nothing decides, it runs `<shell> -c -- "<command>"` unchanged. The `--` ends the options, so a command that begins with a dash is still a command.

   - The exports are inside the `-c` string so they run **after** the shell's own startup files. zsh reads `.zshenv` for every `-c`, and one that exports the proxy again would undo a floor set before the shell started.
   - `NO_PROXY` / `no_proxy` are never touched.
   - The six names and the single value are fixed, so another tool that writes the same six names with the same value gives the same result whichever runs first.
   - `<shell>` is the one Claude Code runs that command under. Its Bash tool runs under bash or zsh. What it hands the prefix is Claude Code's own clauses with the user's command quoted into an `eval` after them, and the script reads the shell from those clauses and never from the command. The first clause sources a shell snapshot (`source .../shell-snapshots/snapshot-zsh-... 2>/dev/null || true`, read up to its first ` 2>/dev/null`), and the file name names the shell. When Claude Code could not make a snapshot, the setup clause it adds whenever a prefix is set (`{ shopt -u extglob || setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL; } >/dev/null 2>&1 || true && `) marks the Bash tool instead, and the shell is `zsh`, then `bash` (`bash` first when `SHELL` names bash). Either way the shell is `CLAUDE_CODE_SHELL`, then `SHELL`, each only if it names that shell and is executable; otherwise it is found on `PATH` and in `/bin`, `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`; otherwise `/bin/sh`. A `SHELL` of fish, or none, still runs bash or zsh. Every other command (command hooks, stdio MCP server commands, the `statusLine` command) runs under `/bin/sh`, as it does without the prefix, and stays there when its text names a snapshot path, contains the setup clause or contains `&& pwd -P >| `: only a string that begins with `source ` and a snapshot path, or with the setup clause, is the Bash tool's.

## Install

Add the prefix to the `env` block of `~/.claude/settings.json` (or a project's `.claude/settings.json`), next to the forward-proxy wiring:

```json
{
  "env": {
    "HTTPS_PROXY": "http://127.0.0.1:9801",
    "NO_PROXY": "127.0.0.1,localhost,::1",
    "NODE_EXTRA_CA_CERTS": "/abs/path/to/.claude/cache-fix-ca/ca.pem",
    "CLAUDE_CODE_SHELL_PREFIX": "/abs/path/to/claude-code-cache-fix/bin/child-proxy-floor.sh"
  }
}
```

The prefix must be an absolute path and the file executable. From an npm global install the script is `$(npm root -g)/claude-code-cache-fix/bin/child-proxy-floor.sh`: the package ships `bin/` and the file keeps its executable bit (`ls -l` it to check). `settings.json` does not expand `$(...)`, so run `npm root -g` once and paste the absolute result. cache-fix and the session should resolve the same Claude config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`), because that is where the file is looked up first; the script also tries `~/.claude/proxy-floor/`.

**Why the `env` block and not only your shell.** A `claude` started from a Bash command inherits the floor, not cache-fix, so it would bypass the proxy. Claude Code applies its `env` block over the inherited environment at boot, so the nested `claude` re-wires itself to cache-fix. Measured on Claude Code 2.1.296 in an empty config directory with a throwaway API key: `settings.json` `env.HTTPS_PROXY` set to listener A, `HTTPS_PROXY` in the launching environment set to listener B. `claude -p hi` dialled A 29 times and B 0 times, every one a `CONNECT api.anthropic.com:443`. With no `env` entry the same run dialled B 29 times and A 0.

**The launcher does not write the `env` block.** `cache-fix-proxy --remote-control` (and `claude-via-proxy`) wire `HTTPS_PROXY` and the CA into the `claude` process only. With the prefix set and no `env` entry, a `claude` started from a Bash command inherits the floor, not cache-fix, and bypasses it. So the prefix is for sessions wired through the `settings.json` `env` block, which a nested `claude` applies again at boot. If you launch through the launcher and also set the prefix, put `HTTPS_PROXY` (on a fixed proxy port) and `NODE_EXTRA_CA_CERTS` in that `env` block too.

**Another proxy in front of cache-fix.** If something else is the session's proxy and forwards to cache-fix, add only the `CLAUDE_CODE_SHELL_PREFIX` line and leave `HTTPS_PROXY` pointing at the front proxy. The script finds the floor file for whichever loopback port the variables name.

**One slot.** `CLAUDE_CODE_SHELL_PREFIX` holds one command, so there is room for one script. Any prefix script that honours the `proxy-floor/` directory gives the same answer, so if a proxy in front of cache-fix already sets the prefix and reads that directory, keep it and skip this script.

**Opt out** by not setting the prefix. There is no other switch.

## What it reaches

Measured on Claude Code 2.1.296 with no credentials, a throwaway config directory, `HTTPS_PROXY` in the `env` block naming a dead loopback port, a floor file for that port naming a stand-in hop, and a `.zshenv` and `.zshrc` that export all six variables back to the dead port. Every child logged the proxy it saw (`urllib.request.getproxies()`):

| child | with the prefix | without it (control) |
|---|---|---|
| Bash tool under zsh, foreground and background, with a snapshot and without | stand-in hop (12 of 12) | the dead port (12 of 12) |
| Bash tool under bash, foreground and background, with a snapshot and without | stand-in hop (12 of 12) | the dead port (12 of 12) |
| command hooks (`SessionStart`, `UserPromptSubmit`, `StopFailure`, `SessionEnd`) | stand-in hop (7 of 7) | the dead port (7 of 7) |
| stdio MCP server, from `--mcp-config` and from a plugin | stand-in hop (6 of 6) | the dead port (6 of 6) |
| `statusLine` command | stand-in hop (1 of 1) | the dead port (1 of 1) |

In every prefixed zsh run (12 of 12) the `.zshenv` had executed (a variable it exports was visible to the child) and its re-export still lost to the floor. A `BASH_ENV` that re-exports ran in the 6 prefixed bash runs with no snapshot and lost there too; in the 6 with a snapshot it did not run.

The hook and stdio MCP rows were measured with `zsh` running every command, then repeated after the script moved them to `/bin/sh` (`dash` 0.5.11 here): `claude -p` with `SHELL` naming `zsh`, a `SessionStart` and a `SessionEnd` hook and one `--mcp-config` server, each logging `readlink /proc/$$/exe` and `getproxies()`. With the prefix 2 of 2 hooks and 1 of 1 server saw the stand-in hop; without it they saw the dead port. In both runs the hooks ran under `dash`, not `zsh`.

The Bash-tool and `statusLine` rows were measured again with the script as it is now, which reads the shell from Claude Code's own leading clauses. The Bash tool was driven by calling its `Bash` tool through `claude mcp serve`, with `SHELL` naming zsh and then bash, with the snapshot Claude Code makes and with Claude Code unable to make one (a regular file where `shell-snapshots` goes). Each run sent six commands: two foreground, two background, one ending in ` 2>/dev/null`, and one that echoes a zsh snapshot path and `&& pwd -P >| x`. Each logged `readlink /proc/$$/exe` and `getproxies()`. The shell was the one `SHELL` named in 24 of 24 commands (zsh 12 of 12, bash 12 of 12) and `getproxies()` named the stand-in hop in 24 of 24 with the prefix and the dead port in 24 of 24 without it. The `statusLine` command ran in an interactive session under `dash`: the stand-in hop with the prefix (1 of 1), the dead port without it (1 of 1). The `SessionStart` and `SessionEnd` hooks in these runs also ran under `dash`: the stand-in hop in 6 of 6 with the prefix, the dead port in 6 of 6 without it.

**Process tree.** Measured directly, `zsh` 5.9 and `bash` 5.1 `exec` the final command of `export ...; command`, and `dash` 0.5.11 does not. Hooks, stdio MCP servers and the `statusLine` command run under `/bin/sh`, which is `dash` on Debian and Ubuntu, so with the prefix the shell stays as the server's parent: a stdio MCP server's parent was `sh` with the prefix and `claude` without it. Claude Code then signals the shell and not the server. Measured under Claude Code with `dash` in that role, after `claude -p` finished the servers that exit on stdin EOF were gone, but one that ignores EOF was still running. Bash 3.2 (macOS `/bin/bash`, and `/bin/sh` there) was not measured.

## Limits

- **Not reached:** `apiKeyHelper`, `otelHeadersHelper`, `awsCredentialExport`, Claude Code's own `git` and `gh` calls, and LSP servers. Claude Code starts them without the prefix, so they inherit cache-fix's port. cache-fix passes every non-Anthropic `CONNECT` through as a blind tunnel to its hop (`blindTunnel` in `proxy/forward-proxy.mjs`), so they cost it little, but they still enter its port.
- **A floor of empty means direct.** When cache-fix has no upstream proxy configured, children are exported `HTTPS_PROXY=''` and connect straight out. Measured with all six variables set to `''`: `curl` and Python `urllib` both connected to the target themselves and neither contacted a proxy (`getproxies() == {}`). On a host that reaches the internet only through a proxy, point cache-fix at that proxy (`HTTPS_PROXY` in the proxy's own environment) so there is a hop to publish.
- **A stopped proxy leaves its file.** A successor on the same port rewrites it when its first request's walk lands (at listen if it has nothing to walk); in between, children keep the last hop.
- **macOS and Linux.** The script needs a POSIX `sh`.

## Troubleshooting

- Children still show cache-fix's port: the file is missing or unreadable. `cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/proxy-floor/9801"` (use your port) should print a URL, or nothing for direct. No file means unknown, which leaves the proxy unchanged: besides a proxy that has not started or has not yet served an HTTPS request, that is what a chain with no reachable hop, a hop URL with credentials and an unparseable value look like. Check that cache-fix runs in forward-proxy mode, listens on a fixed port, and shares your config directory.
- Check the script alone: `HTTPS_PROXY=http://127.0.0.1:9801 bin/child-proxy-floor.sh 'echo "$HTTPS_PROXY"'`.
