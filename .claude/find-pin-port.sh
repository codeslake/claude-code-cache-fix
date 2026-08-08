#!/bin/bash
# Which port is the PIN on, on THIS host? Prints `PIN <port>` per match.
#
# SHIPPED, not scratch, for the same reason gap-probe.mjs is: it is the step that
# decides what the probe POINTS AT during the one-shot pin-recycle window, and a
# wrong port there is a true measurement of the wrong subject with no second
# chance to notice.
#
# IDENTIFIES BY FIELD SET, never by port number or process name. Measured
# 2026-08-08 — the port differs per host (lambda-docker 36301, via-work-mac
# 53749, via-personal-mac 59857), so no constant works. And a name is worse than
# useless: `lsof | grep python | head -1` returned 19801 on via-personal-mac, a
# different python listener entirely, while the pin was on 59857. Same trap as a
# field name appearing on two endpoints — ask what the thing SERVES.
#
# Read-only: a /health GET per listening port, no daemon contact beyond that.
for p in $(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '{print $9}' | sed 's/.*://' | sort -un); do
  b=$(curl -s --max-time 2 --noproxy '*' "http://127.0.0.1:$p/health" 2>/dev/null) || continue
  case "$b" in
    *'"can_pin"'*|*'"pin_proxy"'*) echo "PIN $p" ;;
  esac
done
