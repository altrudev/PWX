#!/usr/bin/env bash
# DNS-rebinding precondition: does pwx-local answer requests whose Host is a foreign name?
set -u
cd "$(dirname "$0")/.."
H=$(mktemp -d)
PWX_HOME=$H node local/pwx-local.mjs add packages/notes.pwx.json >/dev/null
PWX_HOME=$H node local/pwx-local.mjs serve >/dev/null 2>&1 &
D=$!
sleep 1
for path in /packages/notes.pwx.json /__pwx/mode "/__pwx/origin?id=rebind.test"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: attacker.example" "http://127.0.0.1:7100$path")
  [ "$code" = 200 ] && echo "EXPLOITED Host: attacker.example GET $path -> HTTP $code" || echo "blocked   Host: attacker.example GET $path -> HTTP $code"
done
echo "ports.json now: $(cat $H/ports.json | tr -d '\n ')"
kill $D; rm -rf "$H"
