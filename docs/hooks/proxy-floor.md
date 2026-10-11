# proxy-floor — SessionStart hook

**Script:** `hooks/examples/proxy-floor.mjs`

In [forward-proxy mode](../../README.md#forward-proxy-mode-keeps-remote-control-working) you point Claude Code at cache-fix with `HTTPS_PROXY=http://127.0.0.1:<port>`. Claude Code hands its environment to everything the session starts, so every Bash-tool command (`aws`, `git`, `pip`, `curl`) inherits that proxy too, and bulk transfers ride cache-fix even though only `api.anthropic.com` needs it.

This hook gives those commands cache-fix's own upstream instead. At session start it reads the hop cache-fix forwards to from `/health`, and appends exports for the six proxy variables to `$CLAUDE_ENV_FILE`, which Claude Code sources before each Bash command. A command then goes to the same corporate proxy cache-fix uses, or direct when cache-fix has none, and never to cache-fix.

## What it does

1. Acts only when one of `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, `all_proxy` in its own environment is a URL whose host is loopback (`127.0.0.1`, `localhost`, `::1`) and whose port is cache-fix's. Anything else: exit 0, nothing written.
2. Reads `GET http://127.0.0.1:<port>/health` (no proxy, 1.5 s timeout). Unreachable, non-200 or unparseable: exit 0, nothing written.
3. Takes the `https_proxy` field as the floor: the hop cache-fix itself forwards to, or the empty string when it is `null` or absent.
4. Appends six lines to `$CLAUDE_ENV_FILE` (nothing if it is unset), one per variable, with the value single-quoted:

   ```sh
   export HTTPS_PROXY='http://proxy.example.test:3128'
   export https_proxy='http://proxy.example.test:3128'
   export HTTP_PROXY='http://proxy.example.test:3128'
   export http_proxy='http://proxy.example.test:3128'
   export ALL_PROXY='http://proxy.example.test:3128'
   export all_proxy='http://proxy.example.test:3128'
   ```

It never touches `NO_PROXY` / `no_proxy`, and never writes `unset` (Claude Code's env-file parser accepts only assignments). Any error exits 0: the hook never fails the session.

The six keys and the value are a fixed contract, so another hook that writes the same six lines with the same value gives the same result in either order.

## Install

Add to `~/.claude/settings.json` (or per-project `.claude/settings.json`):

```jsonc
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          { "type": "command", "command": "/abs/path/to/hooks/examples/proxy-floor.mjs 9801" }
        ]
      }
    ]
  }
}
```

The trailing number is cache-fix's port. Omit it to use `CACHE_FIX_PROXY_PORT` from the hook's environment, else `9801`. The `command` must be an absolute path, and the file executable.

## Opt out

`CACHE_FIX_CHILD_PROXY=keep` in the environment Claude Code starts with makes the hook write nothing, so Bash-tool commands keep the inherited proxy.

## Limits

- **Bash-tool commands only.** `CLAUDE_ENV_FILE` is sourced by the Bash tool alone. Other children (stdio MCP servers, hooks, the `statusLine` command) still inherit the proxy. cache-fix blind-tunnels every non-Anthropic `CONNECT` to its hop (`blindTunnel` in `proxy/forward-proxy.mjs`), so their traffic costs it little, but it still enters its port.
- **A floor of `""` means direct.** When cache-fix has no hop, Bash-tool commands are exported `HTTPS_PROXY=''` and connect straight out. On a host that reaches the internet only through a proxy, point cache-fix at that proxy (`HTTPS_PROXY` in the proxy's own environment) so there is a hop to publish.
- **An empty value is direct, not an error.** Measured with all six variables set to `''`: `curl` and Python `urllib` both connected to the target themselves and neither contacted a proxy, and `curl -sS -o /dev/null -w '%{http_code}' https://example.com` and `urllib.request.urlopen('https://example.com')` both returned `200`.
- **The floor is read once, at session start.** If cache-fix's hop changes later, restart the session or `/clear` (the matcher includes `clear`) to refresh it.

## Re-wiring a nested `claude`

A `claude` started from a Bash command inherits the floor, not cache-fix, so it would bypass the proxy. Put the wiring in `settings.json` as well as in your shell:

```json
{
  "env": {
    "HTTPS_PROXY": "http://127.0.0.1:9801",
    "NO_PROXY": "127.0.0.1,localhost,::1",
    "NODE_EXTRA_CA_CERTS": "/abs/path/to/.claude/cache-fix-ca/ca.pem"
  }
}
```

Measured on Claude Code 2.1.296, in an empty config directory with a throwaway API key: `settings.json` `env.HTTPS_PROXY` set to listener A, `HTTPS_PROXY` in the launching environment set to listener B. `claude -p hi` dialled A 29 times and B 0 times, every one a `CONNECT api.anthropic.com:443`. With no `env` entry in `settings.json` the same run dialled B 29 times and A 0. So the `settings.json` value overrides the inherited one at boot.
