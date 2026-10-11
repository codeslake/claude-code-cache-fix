# Child proxy floor

**Script:** `bin/child-proxy-floor.sh` (POSIX sh) &nbsp; **Setting:** `CLAUDE_CODE_SHELL_PREFIX`

In [forward-proxy mode](../README.md#forward-proxy-mode-keeps-remote-control-working) you point Claude Code at cache-fix with `HTTPS_PROXY=http://127.0.0.1:<port>`. Claude Code hands its environment to everything the session starts, so every Bash-tool command (`aws`, `git`, `pip`, `curl`), command hook, stdio MCP server and `statusLine` command inherits that proxy too. Bulk transfers then ride cache-fix even though only `api.anthropic.com` needs it.

The floor gives those processes cache-fix's own upstream instead: the corporate proxy cache-fix dials through, or a direct connection when it has none. They never enter cache-fix's port.

## How it works

1. **cache-fix publishes its hop.** In forward-proxy mode, at listen and whenever the hop it dials through changes, it writes `cache-fix-child-proxy-<port>` next to its other state (`$CLAUDE_CONFIG_DIR`, default `~/.claude`). `<port>` is the port clients put in `HTTPS_PROXY` (the advertised port when a holder runs the proxy; a proxy started on port `0` publishes nothing). The write is atomic (temp file, then rename). The same address `/health` reports as `https_proxy` is the content, with credentials dropped.

   | file | meaning |
   |---|---|
   | absent | unknown. The script changes nothing. |
   | empty | cache-fix dials direct, so children do too. |
   | a URL | that hop. |

   With `CACHE_FIX_REQUIRE_HOP=1` and no hop, the file is removed rather than emptied: direct is forbidden there, so "unknown" (children keep cache-fix, which refuses) is the safe answer.

2. **The script reads it.** Claude Code runs every shell command through `CLAUDE_CODE_SHELL_PREFIX`, passing one argument: the full command string. The script looks at `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, `all_proxy` in order. The first one that is a loopback URL (`127.0.0.1`, `localhost`, `[::1]`) whose port has a readable floor file decides. It then runs the command as `"$SHELL" -c "export HTTPS_PROXY='<floor>' https_proxy='<floor>' HTTP_PROXY='<floor>' http_proxy='<floor>' ALL_PROXY='<floor>' all_proxy='<floor>'; <command>"`. If nothing decides, it runs `"$SHELL" -c "<command>"` unchanged.

   - The exports are inside the `-c` string so they run **after** the shell's own startup files. zsh reads `.zshenv` for every `-c`, and one that exports the proxy again would undo a floor set before the shell started.
   - `NO_PROXY` / `no_proxy` are never touched.
   - The six names and the single value are fixed, so another tool that writes the same six names with the same value gives the same result whichever runs first.

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

The prefix must be an absolute path and the file executable. cache-fix and the session must resolve the same Claude config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`), because that is where the file is looked up.

**Why the `env` block and not only your shell.** A `claude` started from a Bash command inherits the floor, not cache-fix, so it would bypass the proxy. Claude Code applies its `env` block over the inherited environment at boot, so the nested `claude` re-wires itself to cache-fix. Measured on Claude Code 2.1.296 in an empty config directory with a throwaway API key: `settings.json` `env.HTTPS_PROXY` set to listener A, `HTTPS_PROXY` in the launching environment set to listener B. `claude -p hi` dialled A 29 times and B 0 times, every one a `CONNECT api.anthropic.com:443`. With no `env` entry the same run dialled B 29 times and A 0.

**One prefix only.** `CLAUDE_CODE_SHELL_PREFIX` holds one command. If a proxy in front of cache-fix already sets it, keep that one and skip this script: that proxy's own floor is what children get.

**Opt out** by not setting the prefix. There is no other switch.

## What it reaches

Measured on Claude Code 2.1.296 with no credentials, a throwaway config directory, `HTTPS_PROXY` in the `env` block naming a dead loopback port, a floor file for that port naming a stand-in hop, and a `.zshenv` and `.zshrc` that export all six variables back to the dead port. Every child logged the proxy it saw (`urllib.request.getproxies()`):

| child | with the prefix | without it (control) |
|---|---|---|
| Bash tool, foreground and background | stand-in hop (2 of 2) | the dead port (2 of 2) |
| command hooks (`SessionStart`, `UserPromptSubmit`, `StopFailure`, `SessionEnd`) | stand-in hop (7 of 7) | the dead port (7 of 7) |
| stdio MCP server, from `--mcp-config` and from a plugin | stand-in hop (6 of 6) | the dead port (6 of 6) |
| `statusLine` command | stand-in hop (1 of 1) | the dead port (1 of 1) |

In every prefixed run the `.zshenv` had executed (a variable it exports was visible to the child) and its re-export still lost to the floor.

**Process tree.** Measured directly, `zsh` 5.9 and `bash` 5.1 `exec` the final command of `export ...; command`, and `dash` does not. With `zsh` as `$SHELL` under Claude Code, a stdio MCP server is therefore Claude Code's direct child exactly as without the prefix, and after `SIGTERM` to Claude Code all three probe servers were gone, including one that ignores stdin EOF. With `dash` the shell stays as the server's parent, so Claude Code signals the shell and not the server: after `claude -p` finished, the servers that exit on stdin EOF were gone, but one that ignores EOF was still running. Bash 3.2 (macOS `/bin/bash`) was not measured.

## Limits

- **Not reached:** `apiKeyHelper`, `otelHeadersHelper`, `awsCredentialExport`, Claude Code's own `git` and `gh` calls, and LSP servers. Claude Code starts them without the prefix, so they inherit cache-fix's port. cache-fix passes every non-Anthropic `CONNECT` through as a blind tunnel to its hop (`blindTunnel` in `proxy/forward-proxy.mjs`), so they cost it little, but they still enter its port.
- **A floor of empty means direct.** When cache-fix has no hop, children are exported `HTTPS_PROXY=''` and connect straight out. Measured with all six variables set to `''`: `curl` and Python `urllib` both connected to the target themselves and neither contacted a proxy (`getproxies() == {}`). On a host that reaches the internet only through a proxy, point cache-fix at that proxy (`HTTPS_PROXY` in the proxy's own environment) so there is a hop to publish.
- **A stopped proxy leaves its file.** A successor on the same port rewrites it at listen; in between, children keep the last hop.
- **POSIX shells on macOS and Linux.** The script is `/bin/sh`.

## Troubleshooting

- Children still show cache-fix's port: the file is missing or unreadable. `cat "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/cache-fix-child-proxy-9801"` (use your port) should print a URL, or nothing for direct. No file means unknown, which leaves the proxy unchanged. Check that cache-fix runs in forward-proxy mode, listens on a fixed port, and shares your config directory.
- Check the script alone: `HTTPS_PROXY=http://127.0.0.1:9801 bin/child-proxy-floor.sh 'echo "$HTTPS_PROXY"'`.
