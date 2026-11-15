#!/usr/bin/env bash
# PWX audit: static checks, then every exploit in every engine.
set -u
cd "$(dirname "$0")"
SPIKE="$(cd .. && pwd)"
PY="$SPIKE/.venv/bin/python"
# The attacker site's self-signed test certificate is made locally and never committed.
[ -f attacker/key.pem ] || openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout attacker/key.pem -out attacker/cert.pem -days 365 -subj /CN=127.0.0.2 \
  -addext subjectAltName=IP:127.0.0.2 2>/dev/null
(cd "$SPIKE" && node tools/build-packages.mjs >/dev/null) && node build.mjs
(cd "$SPIKE" && exec node server/serve.mjs) > /tmp/pwx-audit-serve.log 2>&1 &
S1=$!
node attacker/server.mjs > /tmp/pwx-audit-attacker.log 2>&1 &
S2=$!
trap 'kill $S1 $S2 2>/dev/null' EXIT
sleep 1
echo "##### static checks"
code=$(curl -s -o /tmp/key.out -w '%{http_code}' http://127.0.0.1:8100/packages/.dev-key.json)
grep -q '"d"' /tmp/key.out && echo "EXPLOITED hosted server serves the private signing key (HTTP $code, JWK with \"d\")" || echo "blocked   signing key not served (HTTP $code)"
for u in http://127.0.0.1:8100/; do
  h=$(curl -sI "$u" | grep -iE '^(x-frame-options|content-security-policy):' | tr -d '\r')
  echo "$h" | grep -qiE 'frame-ancestors|x-frame-options' && echo "blocked   $u not frameable" || echo "EXPLOITED $u can be framed by any site (clickjacking): $h"
done
code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Sec-Fetch-Dest: document' -H 'Sec-Fetch-Site: cross-site' http://127.0.0.1:8110/__pwx/bootstrap.html)
[ "$code" = 200 ] && echo "EXPLOITED bootstrap served as a tab (HTTP $code)" || echo "blocked   bootstrap refused as a tab (HTTP $code)"
bash host_header.sh
for b in chromium firefox webkit; do timeout 400 $PY exploits.py --browser "$b"; done
echo ALLDONE
