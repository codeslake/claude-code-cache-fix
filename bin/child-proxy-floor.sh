#!/bin/sh
# CLAUDE_CODE_SHELL_PREFIX script: every process Claude Code starts through a
# shell (Bash tool, command hooks, stdio MCP servers, statusLine) gets the hop
# cache-fix itself dials through, instead of cache-fix. See docs/child-proxy-floor.md.
#
# Claude Code calls this with ONE argument, the full command string. The proxy
# variables in our environment name cache-fix (a loopback port); the file
# <config dir>/proxy-floor/<port>, written by that proxy (or any other local
# proxy that follows the convention), says where its own traffic goes. Three
# states: no file = unknown, run the command unchanged; empty file = direct; a
# URL = that hop. NO_PROXY is never touched.
#
# The exports go INSIDE the -c string, not before the exec: zsh reads .zshenv on
# every -c, and a .zshenv that exports the proxy again would undo a floor set
# earlier. The six keys and the single value are shared with other tools that
# write the same floor, so none of this can be reordered or narrowed.
cmd=$1
for url in "${HTTPS_PROXY-}" "${https_proxy-}" "${HTTP_PROXY-}" "${http_proxy-}" "${ALL_PROXY-}" "${all_proxy-}"; do
  hostport=${url#*://}; hostport=${hostport%%/*}; hostport=${hostport##*@}
  port=${hostport##*:}
  case ${hostport%:*} in 127.0.0.1|localhost|'[::1]') ;; *) continue ;; esac
  case $port in ''|*[!0-9]*) continue ;; esac
  for dir in "${CLAUDE_CONFIG_DIR:-${HOME-}/.claude}" "${HOME-}/.claude"; do
    file=$dir/proxy-floor/$port
    [ -r "$file" ] || continue
    q=$(sed "s/'/'\\\\''/g" "$file") || continue   # single-quote-escaped: the floor stays one value
    cmd="export HTTPS_PROXY='$q' https_proxy='$q' HTTP_PROXY='$q' http_proxy='$q' ALL_PROXY='$q' all_proxy='$q'; $1"
    break 2
  done
done

# The shell Claude Code itself runs commands under: CLAUDE_CODE_SHELL, then SHELL,
# each only if it names bash or zsh and is executable; else zsh, then bash (bash
# first when SHELL names bash) from PATH and the usual directories; else /bin/sh.
# $SHELL as given may be fish, or unset.
shell=
for s in "${CLAUDE_CODE_SHELL-}" "${SHELL-}"; do
  case $s in *bash*|*zsh*) [ -x "$s" ] && shell=$s && break ;; esac
done
if [ -z "$shell" ]; then
  case ${SHELL-} in *bash*) names='bash zsh' ;; *) names='zsh bash' ;; esac
  for n in $names; do
    shell=$(command -v "$n") && [ -x "$shell" ] && break
    for d in /bin /usr/bin /usr/local/bin /opt/homebrew/bin; do [ -x "$d/$n" ] && shell=$d/$n && break 2; done
    shell=
  done
fi
# `--` ends the options: a command beginning with a dash is a command, not a flag cluster.
exec "${shell:-/bin/sh}" -c -- "$cmd"
