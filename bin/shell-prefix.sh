#!/bin/sh
# A CLAUDE_CODE_SHELL_PREFIX program: unsets the six proxy variables for what Claude Code
# starts (Bash tool, hooks, stdio MCP servers, statusLine). It reads only variables
# Claude Code sets per child kind (CLAUDE_PROJECT_DIR, CLAUDE_PID, SHELL), never the command.
u='unset HTTPS_PROXY https_proxy HTTP_PROXY http_proxy ALL_PROXY all_proxy'; eval "$u"
# Bash tool (Claude puts no CLAUDE_PROJECT_DIR there): remember which Claude this is
[ -z "${CLAUDE_PROJECT_DIR+x}" ] && export SHELL_PREFIX_CLAUDE_PID="${CLAUDE_PID-}"
# the user's own earlier prefix gets the command exactly as Claude gave it; the variable is
# dropped first, so a chain that comes back to this file ends here; a missing file or a relative name is skipped
p=${CACHE_FIX_PREV_SHELL_PREFIX-}; unset CACHE_FIX_PREV_SHELL_PREFIX
case $p in /*) [ -f "$p" ] && [ -x "$p" ] && exec "$p" "$1" ;; esac
# Bash tool: the shell Claude chose (it sets SHELL); unset again after its startup files
[ -z "${CLAUDE_PROJECT_DIR+x}" ] && exec "${SHELL:-/bin/sh}" -c "$u; $1"
# hook or statusLine: Claude stamped its own pid on it; run it under /bin/sh, as without a prefix
[ -n "${CLAUDE_PID+x}" ] && [ "$CLAUDE_PID" != "${SHELL_PREFIX_CLAUDE_PID-}" ] && exec /bin/sh -c "$u; $1"
# stdio MCP server: one quoted command; become it, so Claude's signals reach the server
eval "exec $1"
