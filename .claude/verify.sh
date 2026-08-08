#!/bin/bash
# CCF — is the deploy actually LIVE on this machine?
# One line per check: <name>\tOK|FAIL\t<detail>. Non-zero exit if any FAIL.
set -u
D="$HOME/.local/share/cache-fix-fork"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
fail=0
# EVERY REQUIRED CHECK MUST SPEAK, and silence is the failure this records.
# `say` raises `fail` only when it is CALLED, so a check whose block was deleted
# or renamed, or whose branches all missed, emits nothing and this script still
# exits 0. Measured on lambda-docker: dropping the whole `deploy-live` block —
# the one check that answers "did the deploy actually take" — left EXIT=0 with
# three checks instead of four. "The deploy check is gone" and "the deploy check
# passed" produced the identical result, and EXIT=0 is what gets quoted.
#
# `discovery` is deliberately absent from this list: it is emitted only on a host
# with no run dir, so requiring it would fail every host that has one.
REQUIRED="launcher ca-trust proxy-live deploy-live ca-trust-live"
seen=""
say() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3"
  case " $seen " in *" $1 "*) ;; *) seen="$seen $1" ;; esac
  [ "$2" = FAIL ] && fail=1
  return 0
}

# 1. The launcher parses at all. A tree that cannot even be loaded is the one
#    failure that makes every other probe meaningless.
launcher="$D/bin/claude-via-proxy.mjs"
if [ ! -r "$launcher" ]; then say launcher FAIL "absent: $launcher"
elif out=$(node --check "$launcher" 2>&1); then say launcher OK "parses"
else say launcher FAIL "${out:-parse failed}"; fi

# 2. The guard agrees with this machine's LIVE bundle.
#
#    This is the check that earns its place: the bundle is written by a third
#    component (cc-wrapper's cachefix-ensure) from inputs neither this repo nor
#    the deploy controls, so a tree that is correct can still meet a bundle it
#    refuses. Probing bin/ca-trust.mjs — the module the launcher imports, not a
#    copy — is the point of it living in its own file.
#
#    Absent bundle is OK, not FAIL: a host with no builder is a supported state
#    and the launcher falls back to its own CA. Absent CA is FAIL — forward-proxy
#    mode cannot work without one.
if [ ! -r "$CFG/cache-fix-ca/ca.pem" ]; then
  say ca-trust FAIL "no proxy CA at $CFG/cache-fix-ca/ca.pem"
elif [ ! -s "$CFG/ca-trust.pem" ]; then
  say ca-trust OK "no merged bundle on this host — launcher uses its own CA"
else
  out=$(node -e '
    import(process.argv[1] + "/bin/ca-trust.mjs").then(async m => {
      const fs = await import("node:fs");
      const cfg = process.argv[2];
      const ca = fs.readFileSync(cfg + "/cache-fix-ca/ca.pem");
      const merged = fs.readFileSync(cfg + "/ca-trust.pem", "utf8");
      const n = (merged.match(/^-----BEGIN CERTIFICATE-----$/gm) || []).length;
      // Ask the loader, do not predict it: the same question the launcher asks
      // on every start. `carriesOurCA` is tri-state — true / false / null,
      // where null is "could not ask" and must not be reported as either.
      const v = m.carriesOurCA(cfg + "/ca-trust.pem", ca);
      const word = v === true ? "carries our CA"
                 : v === false ? "REFUSED — node loads no CA of ours from it"
                 : "UNKNOWN — the probe could not answer";
      console.log(n + " certs: " + word);
      process.exit(v === false ? 1 : 0);
    }).catch(e => { console.log("threw: " + e.message); process.exit(1); });
  ' "$D" "$CFG" 2>&1)
  if [ $? -eq 0 ]; then say ca-trust OK "$out"; else say ca-trust FAIL "$out"; fi
fi

# 3. A proxy answers, on the port the sessions were actually built against —
#    a session that started during a reload window baked whatever port it got,
#    and asserting the default would pass while every live session dialled a
#    dead one.
#
#    The run dir `<TMPDIR-or-/tmp>/cachefix-<port>` is where that port is
#    recorded; it is the same discovery cc-check-ccf's probe uses. This read
#    ~/.claude.json for CLAUDE_CODE_CACHE_FIX_PORT until 2026-08-01, and no
#    such key exists — the launcher's variable is CACHE_FIX_PROXY_PORT and it
#    lives in the proxy's own env. Measured on all three machines: 0 matches,
#    so the sed produced nothing and `${port:-9901}` supplied the default every
#    single run. The check asserted precisely the assumption the paragraph
#    above forbids, and would have said OK about a dead port on any machine
#    whose proxy had moved.
#
#    No run dir ⇒ FAIL, never a default. A check that cannot find its subject
#    has not looked; reporting that as OK is the whole failure mode.
#
#    Collected in a plain loop, NOT `$(for ... done | sort -u)`: bash 3.2 (which
#    is what macOS ships, and two of the three machines here run) mis-parses a
#    `case` pattern inside `$( )` — it reads the pattern's own `)` as the end of
#    the command substitution and dies on the following `;;`. Measured: both
#    macs exited 2 with "syntax error near unexpected token `;;'" while lmd42's
#    bash 5 ran it fine. The check failed loudly rather than passing, which is
#    the right failure mode, but it still could not do its job on the hosts that
#    had it.
tmp=${TMPDIR:-/tmp}; tmp=${tmp%/}
ports=
for d in "$tmp"/cachefix-* /tmp/cachefix-*; do
  [ -d "$d" ] || continue
  p=${d##*cachefix-}
  case "$p" in ''|*[!0-9]*) continue ;; esac
  case " $ports " in *" $p "*) continue ;; esac   # TMPDIR may already be /tmp
  ports="$ports $p"
done
# SECOND SOURCE, because the first belongs to somebody else. The run dir is
# written by cc-wrapper's cachefix-ensure, not by this tree — so on a machine
# where that never ran, discovery finds nothing and both checks below go blind
# while a healthy proxy serves. Measured on the personal Mac: 9901 answering
# 200 from our own deploy, TMPDIR exactly the one scanned above, and not one
# cachefix-* directory anywhere on the box.
#
# Our own holders know their port and we can read it without help: it is in
# their environment, which is ours to publish and ours to look at.
if [ -z "$ports" ]; then
  for h in $(pgrep -f 'claude-via-proxy.mjs run-service' 2>/dev/null); do
    if [ -r "/proc/$h/environ" ]; then
      p=$(tr '\0' '\n' < "/proc/$h/environ" | sed -n 's/^CACHE_FIX_PROXY_PORT=//p' | head -1)
    else
      p=$(ps -wwE -p "$h" 2>/dev/null | tr ' ' '\n' | sed -n 's/^CACHE_FIX_PROXY_PORT=//p' | head -1)
    fi
    case "$p" in ''|*[!0-9]*) continue ;; esac
    case " $ports " in *" $p "*) continue ;; esac
    ports="$ports $p"
  done
  [ -n "$ports" ] && say discovery OK "no run dir; took$ports from our own holders"
fi

if [ -z "$ports" ]; then
  say proxy-live FAIL "no cachefix-<port> run dir under $tmp or /tmp, and no holder of ours names a port"
else
  for port in $ports; do
    if out=$(curl -sf --max-time 3 --noproxy '*' "http://127.0.0.1:$port/health" 2>&1); then
      case "$out" in
        *'"forward_proxy":true'*) say proxy-live OK "port $port: $out" ;;
        # Answering in reverse-proxy mode is not "up": that mode sets
        # ANTHROPIC_BASE_URL, which is what disables Remote Control.
        *) say proxy-live FAIL "port $port answers but forward_proxy is not true: $out" ;;
      esac
    else
      say proxy-live FAIL "run dir $tmp/cachefix-$port exists but nothing answers 127.0.0.1:$port"
    fi
  done
fi

# 4. IS THE DEPLOY ACTUALLY RUNNING, both layers.
#
#    Checks 1-3 all pass on a machine whose files were updated hours ago and
#    whose processes never restarted — measured repeatedly today, most sharply
#    ten minutes after reporting the fleet current. A deploy nobody relaunches
#    never runs, and every other check here reads the DISK or asks a port
#    whether it answers, neither of which can see that.
#
#    TWO hashes, not one, and each has independently caught what the other
#    missed: a launcher-only commit left holder STALE with proxy MATCH, and a
#    proxy-only commit produced exactly the inverse. A single tree hash would
#    have reported the fleet current on both occasions.
#
#    proxy_tree is the proxy's own loaded source; holder_tree is published by
#    the holder that spawned it, because a STALE holder execs the launcher from
#    disk and therefore spawns a perfectly current proxy — its version cannot be
#    inferred from below.
#
#    Not fatal on its own terms: a stale process is serving, so this reports
#    FAIL to make the state visible, which is the whole point. The repair is a
#    SIGUSR2 to the holder, measured at 0 refused across every machine.
for port in ${ports:-}; do
  live=$(curl -sf --max-time 3 --noproxy '*' "http://127.0.0.1:$port/health" 2>/dev/null)
  if [ -z "$live" ]; then
    # A CARRYING RELAY IS NOT "NOTHING TO CHECK". It answers 503, which `curl
    # -sf` throws away, so this read is empty for both "no proxy at all" and
    # "the address is up with no proxy behind it" — and the second is a deploy
    # that did not take. A check that cannot run must fail, not skip.
    # AND THE ELSE-BRANCH USED TO SKIP, three lines under a comment forbidding
    # exactly that. Nothing answered and it is not a carrying relay, so this
    # check COULD NOT LOOK — which is a FAIL, not a pass. `proxy-live` happens
    # to fail on the same port today, so this never produced a false green on
    # its own; that is shadowing, not coverage, and it disappears the moment
    # either check's port list changes.
    if curl -s --max-time 3 --noproxy '*' "http://127.0.0.1:$port/health" 2>/dev/null \
         | grep -q '"carrying":"gap-relay"'; then
      say deploy-live FAIL "port $port: no proxy is running — a standby relay is carrying the address"
    else
      say deploy-live FAIL "port $port: nothing answered /health, so this check could not look"
    fi
    continue
  fi
  #    ONLY OUR OWN DEPLOY. A box can run other CCF installs on other ports —
  #    the work Mac serves 9902 and 9903 from the npm-global
  #    /opt/homebrew/bin/cache-fix-proxy, which will never carry this tree's
  #    hash. Judging those against our disk reported two healthy proxies as
  #    "deployed, not running" on this check's first real run. Identify by the
  #    executable the LISTENER runs, not by the port answering.
  lpid=$(lsof -nP -t -iTCP@127.0.0.1:"$port" -sTCP:LISTEN 2>/dev/null | head -1)
  [ -z "$lpid" ] && continue
  lcmd=$(ps -o command= -p "$lpid" 2>/dev/null)
  ours=no
  case "$lcmd" in *"$D"*) ours=yes ;; esac
  if [ "$ours" != yes ]; then
    say deploy-live OK "port $port: served by another install, not this tree"
    continue
  fi
  lp=$(printf '%s' "$live" | sed -n 's/.*"proxy_tree":"\([^"]*\)".*/\1/p')
  lh=$(printf '%s' "$live" | sed -n 's/.*"holder_tree":"\([^"]*\)".*/\1/p')
  dp=$(cd "$D/proxy" 2>/dev/null && node --input-type=module -e \
        'const x=await import("./source-fingerprint.mjs");process.stdout.write(String(await x.sourceFingerprint(x.PROXY_ROOT)))' 2>/dev/null)
  # BOTH FILES OF THAT LAYER, matching what the holder publishes — gap-relay.mjs
  # is under bin/, so no fingerprint covered it and a relay-only change was
  # invisible to this check.
  # THE WHOLE DIRECTORY, matching what the holder publishes. Naming files here
  # was wrong twice — the relay, then ca-trust.mjs which the launcher imports —
  # and both times every check called a stale machine current.
  dh=$(node -e 'const c=require("crypto"),f=require("fs"),p=require("path");const d=process.argv[1];const h=c.createHash("sha256");for(const n of f.readdirSync(d).filter(x=>x.endsWith(".mjs")&&!x.startsWith(".")).sort()){h.update(n);h.update(f.readFileSync(p.join(d,n)));}process.stdout.write(h.digest("hex").slice(0,12))' \
       "$D/bin" 2>/dev/null)
  if [ -z "$dp" ] || [ -z "$dh" ]; then
    say deploy-live FAIL "port $port: cannot hash the deployed tree — the check could not look"
  elif [ "$lp" != "${dp%${dp#????????????}}" ]; then
    say deploy-live FAIL "port $port: proxy is running $lp, disk is ${dp%${dp#????????????}} — deployed, not running"
  elif [ -z "$lh" ]; then
    say deploy-live FAIL "port $port: no holder_tree — the holder predates publishing it, so its version is unknown"
  elif [ "$lh" != "$dh" ]; then
    say deploy-live FAIL "port $port: holder is running $lh, disk is $dh — deployed, not running"
  else
    say deploy-live OK "port $port: proxy $lp and holder $lh both match disk"
  fi

  # 5. ASK THE PROCESS THAT ACTUALLY TERMINATES TLS.
  #
  #    Check 2 runs bin/ca-trust.mjs in THIS shell and asks whether a fresh node
  #    process can load our CA from the bundle. That is not the question. The
  #    proxy read its CA at startup and holds it in memory: regenerate the CA
  #    under a running proxy and check 2 still says OK while every handshake
  #    fails. /health publishes no CA fingerprint, so nothing else covers it.
  #
  #    The shape came from cswap's pin: their check ran `cswap pin` in their own
  #    shell, which reads the keychain, while the DAEMON could not — and a Mac
  #    served unpinned for 27 hours behind 8/8 green. A CLI that works is not
  #    evidence about the daemon.
  #
  #    So: a real CONNECT through this port, and verify the leaf it presents
  #    against the CA on this box's disk. Measured 2026-08-08 on all three —
  #    `Verify return code: 0 (ok)`, issuer CN=cache-fix forward-proxy CA;
  #    negative control against the system store gives 19, so a pass here is not
  #    something every store would produce.
  #
  #    Only inside the `ours` branch, so another install's proxy on 9902/9903 is
  #    never asked to present OUR CA. No `timeout` wrapper: macOS ships no
  #    coreutils, and wrapping it made this probe return EMPTY on both Macs —
  #    which reads as failure and is not.
  ca="$CFG/cache-fix-ca/ca.pem"
  if [ ! -r "$ca" ]; then
    say ca-trust-live FAIL "port $port: no CA at $ca to verify the live leaf against"
  else
    v=$(openssl s_client -proxy "127.0.0.1:$port" -connect api.anthropic.com:443 \
          -servername api.anthropic.com -CAfile "$ca" </dev/null 2>/dev/null \
        | sed -n 's/^Verify return code: //p' | head -1)
    case "$v" in
      "0 (ok)") say ca-trust-live OK "port $port: the live leaf chains to $ca" ;;
      "")       say ca-trust-live FAIL "port $port: no handshake to read — the check could not look" ;;
      *)        say ca-trust-live FAIL "port $port: the LIVE leaf does not chain to our CA ($v) — the running proxy is not using $ca" ;;
    esac
  fi
done

# The absence sweep. Runs last so every check has had its chance to speak.
for c in $REQUIRED; do
  case " $seen " in
    *" $c "*) ;;
    *) say "$c" FAIL "check never ran — its block is missing, renamed, or every branch missed" ;;
  esac
done

exit $fail
