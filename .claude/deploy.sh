#!/bin/bash
# CCF — put THIS machine on origin/integrated.
#
# Contract: exit 0 = on the branch; non-zero = not, reason on stdout; one line
# naming the host and the sha.
set -eu
D="$HOME/.local/share/cache-fix-fork"

[ -d "$D/.git" ] || { echo "REFUSE: $(hostname -s):$D is not a checkout"; exit 1; }

# Refuse rather than resolve. `reset --hard` would answer a wrong-branch tree by
# discarding whatever is there, and on this machine that tree is what every live
# session's launcher runs from.
branch=$(git -C "$D" rev-parse --abbrev-ref HEAD)
[ "$branch" = "integrated" ] || {
  echo "REFUSE: $(hostname -s):$D is on '$branch' — a human decides this"; exit 1; }

git -C "$D" fetch origin integrated --quiet
# reset, not merge --ff-only: the rebuild force-pushes `integrated` (it is
# rebuilt from upstream/main every time, never patched), so the deployed copy is
# routinely NOT a fast-forward from its own HEAD. --ff-only would refuse every
# rebuild that dropped a merged PR. Safe here because nothing edits this tree by
# hand — the wrong-branch guard above is what protects the case that matters.
#
# THIS LINE REWRITES THE SCRIPT THAT IS EXECUTING IT, and that is safe only
# because git replaces a file by rename, never in place. Measured: inode changes
# across the reset, so the running bash keeps its fd on the OLD inode and the
# rest of this file executes intact — verified at 814 B, 30 KB and 151 KB, tail
# always reached. Replace this with anything that writes in place (`cp`,
# `install`, `>`) and the same self-replacement TRUNCATES the running script:
# measured, an 894 B script `cp`-ing over itself printed its first line and
# silently lost every statement after the copy. bash reads a script
# incrementally by offset, so the failure scales with file size and looks like
# "the deploy just stopped".
#
# Separate consequence, not a hazard: the run that ships a change to THIS file
# still executes the OLD copy, so a deploy.sh fix takes effect on the NEXT
# deploy. Run it twice when the change is to the deploy itself.
git -C "$D" reset --hard -q origin/integrated
echo "$(hostname -s) @ $(git -C "$D" rev-parse --short HEAD)"

# Re-apply the usage-log opt-in. `usage-log` ships enabled:false in its own
# export default — upstream's deliberate opt-in, activated by an entry in
# proxy/extensions.json. That file is TRACKED, so the reset above reverts it and
# the extension goes quiet with nothing to say it did.
#
# Measured 2026-08-01: ~/.claude/usage.jsonl last written 2026-07-04 — four weeks
# of per-call token accounting missing while the proxy itself was healthy at 96%
# cache hit rate, so /check-usage could not attribute a 5h window that had
# reached 85%. Then measured again the same day: running the one-line
# `reset --hard` deploy took usage-log from {"enabled":true} back to absent.
# This block is why deploy is a script and not a conf string.
python3 - "$D/proxy/extensions.json" <<'PY' || echo "WARN: $(hostname -s) could not enable usage-log (accounting only, proxy unaffected)"
import json, sys
p = sys.argv[1]
with open(p) as f:
    cfg = json.load(f)
if cfg.get("usage-log", {}).get("enabled") is not True:
    cfg["usage-log"] = {"enabled": True, "order": 650}
    with open(p, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
PY

# Put the RUNNING proxy on the code we just deployed.
#
# Node reads proxy/*.mjs once at startup, and extensions are read once at boot
# with hot-reload opt-in and off. So a deploy that stops at `reset --hard`
# updates files nobody is executing: measured 2026-08-01, this box served code
# from Jul 30 while three redeploys reported success, and the usage-log opt-in
# re-applied above did nothing for the live process either.
#
# THIS DEPLOY DOES NOT RESTART ANYTHING. It updates files and reports whether a
# live process is still holding pre-deploy code, per host. Restarting is the
# owner's call, made with the whole fleet in view — not a side effect of a
# deploy that one session runs.
#
# The reload used to happen here, on the reasoning that a note gets walked past
# while a reload does the work. Both halves of that were wrong:
#
#   - The cost was understated. This block claimed "~6s down, and the client
#     retries". Measured against a 12-chunk stream through the real proxy, a
#     reload ended it at ECONNRESET after 18 chunks — a session sees
#     "Connection closed mid-response", and a retry does not un-cut a body that
#     was already half-delivered. Two separate reloads from this script killed
#     in-flight requests in other sessions on this box, both measured by the
#     session that lost them.
#   - "A note is walked past" is a reason to make the note louder, not a reason
#     to take an action nobody else can see coming. Three sessions share this
#     port; only one of them runs the deploy.
#
# The stale-process problem the reload was solving is REAL and is not solved by
# ignoring it — that is what the WARN below is for, and why it names the host
# and says plainly that the running code is not the deployed code.
#
# When the proxy can hand over WITHOUT dropping connections (SO_REUSEPORT, the
# successor binding before the predecessor stops accepting — PR #303), a reload
# here becomes defensible again. Until that ships, it is not.
# THE PRECONDITION THIS PARAGRAPH NAMED HAS SHIPPED. It said a reload here
# becomes defensible once a successor can take the socket before the predecessor
# stops accepting. That is what SIGUSR2 does now: the holder spawns its
# replacement on the descriptor it is already holding and only then leaves, so
# nothing binds and nothing races. Measured on every machine, repeatedly, on
# live 9901 under traffic — 0 refused of 2,887 / 2,907 / 2,914 / 2,935 / 2,947 /
# 2,948 / 2,956 / 2,988 / 3,021 / 3,024 and the same on the other two boxes.
#
# So this deploy finishes the job instead of telling a human to relaunch. That
# gap is not theoretical: "files updated, process not" caught the operator three
# times in one afternoon, twice AFTER they had reported the fleet current.
#
# Hash, not pgrep: the old check reported STALE whenever any proxy was running,
# including one already on this code. proxy_tree is what the process actually
# loaded, and holder_tree is published by the holder above it — a stale holder
# execs the launcher from disk and therefore spawns a CURRENT proxy, so the
# layer above cannot be inferred from below.
# BOTH TREES, because a deploy can change either layer alone. proxy_tree covers
# the proxy's sources; holder_tree covers the launcher that supervises it. A
# launcher-only commit leaves proxy_tree identical, and comparing that alone made
# this print "live proxy already on this code" while verify.sh — which reads both
# — reported the holder stale on the same machine, in the same second. Two
# independent indicators; each has caught what the other missed.
live_tree() {
  curl -sf --max-time 3 --noproxy '*' "http://127.0.0.1:${1}/health" 2>/dev/null \
    | sed -n 's/.*"proxy_tree":"\([^"]*\)".*"holder_tree":"\([^"]*\)".*/\1 \2/p'
}
disk_tree() {
  p=$( (cd "$D/proxy" && node --input-type=module -e \
    'const x=await import("./source-fingerprint.mjs");process.stdout.write(String(await x.sourceFingerprint(x.PROXY_ROOT)))' 2>/dev/null) | cut -c1-12 )
  # BOTH FILES OF THAT LAYER, matching what the holder publishes. gap-relay.mjs
  # is under bin/, not proxy/, so neither fingerprint covered it and a change to
  # it read as "already on this code" on every machine.
  # THE WHOLE DIRECTORY, matching what the holder publishes. Naming files here
  # was wrong twice — the relay, then ca-trust.mjs which the launcher imports —
  # and both times every check called a stale machine current.
  h=$(node -e 'const c=require("crypto"),f=require("fs"),p=require("path");const d=process.argv[1];const h=c.createHash("sha256");for(const n of f.readdirSync(d).filter(x=>x.endsWith(".mjs")&&!x.startsWith(".")).sort()){h.update(n);h.update(f.readFileSync(p.join(d,n)));}process.stdout.write(h.digest("hex").slice(0,12))' \
       "$D/bin" 2>/dev/null)
  printf '%s %s' "$p" "$h"
}
# THE WIRED PORT, and a census of every other one. This used to read 9901 and
# nothing else, which is right about which port MATTERS — wire.zsh dials
# CCF_PORT and the architecture is one proxy per config dir — but wrong about
# what the deploy should SEE. Measured 2026-08-12 on <work-mac>: four live
# cache-fix ports where the design says one.
#
#   9901  v4.4.0-beta.0  a19565a62f68  4d13h   <- wired, matches disk
#   9902  v4.3.0         055114e2c16e  8d01h   <- leftover
#   9903  v4.3.0         055114e2c16e  8d01h   <- leftover
#   9911  v4.4.0-beta.0  c3d74d734635  5d23h   <- leftover, DIFFERENT tree, no run dir
#
# Every deploy in that window exited 0 and said "already on this code", which
# was true of the port it looked at and silent about three orphaned proxies.
#
# They are NOT a relaunch debt — nothing routes to them, so handing their port
# over would be meaningless. They are leftovers, and cleanup is a kill, which
# this script must never do. So: hand over the wired port as before, and NAME
# the others so the census is the operator's to act on.
#
# Enumerated from live LISTENERS, not from run dirs: 9911 has no run dir at all,
# so a run-dir scan would have reproduced the same blindness one level over.
#
# `lsof -a`, NOT `lsof -p X -iTCP`. lsof ORs its selection criteria by default,
# so without -a that reads "pid X OR any TCP" and returns every listener on the
# box — 56 of them here, including ollama and the cswap pin. Caught by the
# negative control (<linux-host> must report zero extras), not by inspection.
#
# `$1 < 10000` keeps ENTRY POINTS only. A holder fronts an inner proxy on an
# ephemeral port (9902's /health reports listen_port=63697), and both processes
# match the command filter, so the raw list carried 63697/63698/39917 too.
# Ephemeral starts at 32768 on Linux and 49152 on macOS; CCF's own ports are the
# 98xx/99xx band the architecture names. Validated both ways: work-mac yields
# exactly 9902 9903 9911, <linux-host> exactly none.
CCF_PORT_WIRED=${CCF_PORT:-9901}
others=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}' | sort -u |
         while read -r pid; do
           ps -o command= -p "$pid" 2>/dev/null | grep -qE 'cache-fix|server\.mjs' || continue
           lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null |
             sed -n 's/.*127\.0\.0\.1:\([0-9]*\) (LISTEN).*/\1/p'
         # `|| true`, because `grep -v` EXITS 1 WHEN IT FILTERS EVERYTHING OUT and
         # `set -e` then kills this script at the assignment — silently, since the
         # only output so far is the sha line above. A machine with no extra proxy
         # is the HEALTHY case, so the guard failed exactly where nothing was
         # wrong. Measured: the fleet's spare proxies were swept, every host became
         # clean, and the next deploy exited 1 on all of them with the files
         # updated and the running process left on the old code.
         done | awk '$1 < 10000' | sort -un | grep -v "^${CCF_PORT_WIRED}$" || true)
for p in $others; do
  echo "EXTRA: $(hostname -s) has a cache-fix proxy on $p, which nothing is wired to"
  echo "       (CCF_PORT=$CCF_PORT_WIRED). Left running: cleanup is a kill and this"
  echo "       deploy never kills. Decide it with the fleet in view."
done
port=$(lsof -nP -t -iTCP@127.0.0.1:"$CCF_PORT_WIRED" -sTCP:LISTEN >/dev/null 2>&1 && echo "$CCF_PORT_WIRED")
if [ -z "${port:-}" ]; then
  echo "$(hostname -s): no live proxy on $CCF_PORT_WIRED; the next launch starts one on this code"
elif [ "$(live_tree "$port")" = "$(disk_tree)" ]; then
  echo "$(hostname -s): live proxy already on this code"
else
  # Only a holder can hand over. A bare proxy has no successor-holder to spawn,
  # so it keeps the old report rather than paying the release route unasked.
  # THE HOLDER, BY NAME. Three of our processes hold this socket now — the
  # holder, the proxy, and the standby relay that outlives them — and lsof does
  # not order them, so `head -1` left it to luck which one a deploy asked to hand
  # the port over. Ask for run-service; fall back to the proxy's parent for the
  # case where only a bare proxy is there.
  H=""
  listeners=$(lsof -nP -t -iTCP@127.0.0.1:"$port" -sTCP:LISTEN 2>/dev/null)
  for p in $listeners; do
    ps -o command= -p "$p" 2>/dev/null | grep -q 'run-service' && H=$p
  done
  if [ -z "$H" ]; then
    for p in $listeners; do
      ps -o command= -p "$p" 2>/dev/null | grep -q 'server\.mjs' \
        && H=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    done
  fi
  # SIGUSR2 IS FATAL TO A HOLDER THAT PREDATES IT. Node's default action for it
  # is termination, so sending it to an older holder kills it outright, orphans
  # its child and leaves nobody supervising — measured earlier today on nine
  # stray holders that came back only because their children self-healed.
  #
  # holder_tree is the gate, and the implication runs the right way: the field
  # was added AFTER the SIGUSR2 handler (a5b4e25 after 2fb61c4), so a holder that
  # publishes it necessarily has the handler. Absent means "older than the field",
  # which is at best "older than the handler" — refuse rather than guess.
  ht=$(curl -sf --max-time 3 --noproxy '*' "http://127.0.0.1:${port}/health" 2>/dev/null \
        | sed -n 's/.*"holder_tree":"\([^"]*\)".*/\1/p')
  if [ -n "${H:-}" ] && [ -n "$ht" ] && ps -o command= -p "$H" 2>/dev/null | grep -q run-service; then
    kill -USR2 "$H" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      sleep 1
      [ "$(live_tree "$port")" = "$(disk_tree)" ] && break
    done
    if [ "$(live_tree "$port")" = "$(disk_tree)" ]; then
      echo "$(hostname -s): handed the port to a proxy on this code"
    else
      echo "STALE: $(hostname -s) asked its holder to hand over and it did not within 20s"
    fi
  else
    if [ -n "${H:-}" ] && [ -z "$ht" ]; then
      echo "STALE: $(hostname -s) has a holder too old to hand the port over safely"
      echo "       (it publishes no holder_tree, so it predates the SIGUSR2 handler and"
      echo "       would be KILLED by the request). Relaunch \`claude\`, or restart"
      echo "       deliberately when no session is mid-response."
    elif curl -s --max-time 3 --noproxy '*' "http://127.0.0.1:${port}/health" 2>/dev/null \
           | grep -q '"carrying":"gap-relay"'; then
      # Not "pre-deploy code" — no code at all. The standby relay holds the
      # address when a holder and its proxy both go, so traffic still moves and
      # nothing caches it. Saying "live proxy" here would send the reader
      # looking for a process that is not running.
      echo "STALE: $(hostname -s) has NO proxy on $port — a standby relay is carrying the"
      echo "       address, so requests flow uncached. Relaunch \`claude\` to put a holder"
      echo "       back; the relay yields the address when one asks for it."
    else
      echo "STALE: $(hostname -s) has a live proxy on pre-deploy code and no holder to hand"
      echo "       over. Relaunch \`claude\`, or restart deliberately when no session"
      echo "       is mid-response."
    fi
  fi
fi

exit 0
