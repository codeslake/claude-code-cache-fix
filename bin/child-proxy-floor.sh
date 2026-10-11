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

# The shell is the one Claude Code runs the command under. Only its Bash tool runs
# under bash or zsh, and the shell snapshot it sources first names which; hooks,
# stdio MCP servers and the statusLine run under /bin/sh, and so do they here. The
# Bash tool without a snapshot (Claude Code could not make one) is told by its cwd
# tail. The bash or zsh is CLAUDE_CODE_SHELL, then SHELL, each only if it names that
# shell and is executable; else it is found on PATH and in the usual directories.
case $1 in
  */shell-snapshots/snapshot-zsh-*) names=zsh ;;
  */shell-snapshots/snapshot-bash-*) names=bash ;;
  *'&& pwd -P >| '*) case ${SHELL-} in *bash*) names='bash zsh' ;; *) names='zsh bash' ;; esac ;;
  *) names= ;;
esac
shell=
for s in "${CLAUDE_CODE_SHELL-}" "${SHELL-}"; do
  for n in $names; do
    case $s in *"$n"*) [ -x "$s" ] && shell=$s && break 2 ;; esac
  done
done
if [ -z "$shell" ]; then
  for n in $names; do
    shell=$(command -v "$n") && break
    for d in /bin /usr/bin /usr/local/bin /opt/homebrew/bin; do [ -x "$d/$n" ] && shell=$d/$n && break 2; done
    shell=
  done
fi
# `--` ends the options: a command beginning with a dash is a command, not a flag cluster.
exec "${shell:-/bin/sh}" -c -- "$cmd"
