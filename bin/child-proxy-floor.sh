#!/bin/sh
# CLAUDE_CODE_SHELL_PREFIX script: every process Claude Code starts through a
# shell (Bash tool, command hooks, stdio MCP servers, statusLine) gets the hop
# cache-fix itself dials through, instead of cache-fix. See docs/child-proxy-floor.md.
#
# Claude Code calls this with ONE argument, the full command string. The proxy
# variables in our environment name cache-fix (a loopback port); the file
# cache-fix-child-proxy-<port>, written by that proxy, says where its own
# traffic goes. Three states: no file = unknown, run the command unchanged;
# empty file = direct; a URL = that hop. NO_PROXY is never touched.
#
# The exports go INSIDE the -c string, not before the exec: zsh reads .zshenv on
# every -c, and a .zshenv that exports the proxy again would undo a floor set
# earlier. The six keys and the single value are shared with other tools that
# write the same floor, so none of this can be reordered or narrowed.
dir=${CLAUDE_CONFIG_DIR:-${HOME:-}/.claude}
for url in "${HTTPS_PROXY-}" "${https_proxy-}" "${HTTP_PROXY-}" "${http_proxy-}" "${ALL_PROXY-}" "${all_proxy-}"; do
  hostport=${url#*://}; hostport=${hostport%%/*}; hostport=${hostport##*@}
  port=${hostport##*:}
  case ${hostport%:*} in 127.0.0.1|localhost|'[::1]') ;; *) continue ;; esac
  case $port in ''|*[!0-9]*) continue ;; esac
  file=$dir/cache-fix-child-proxy-$port
  [ -r "$file" ] || continue
  q=$(sed "s/'/'\\\\''/g" "$file") || continue   # single-quote-escaped: the floor stays one value
  exec "${SHELL:-/bin/sh}" -c "export HTTPS_PROXY='$q' https_proxy='$q' HTTP_PROXY='$q' http_proxy='$q' ALL_PROXY='$q' all_proxy='$q'; $1"
done
exec "${SHELL:-/bin/sh}" -c "$1"
