#!/usr/bin/env bash
# Installs (or updates) the PWX witness as a systemd user service on this machine.
#   bash tools/install-witness.sh <name> <port> <log origin> <log public key> <log URL>
# Keeps its own copy of the code, so switching branches in the repo doesn't change a running
# witness. Key: ~/.config/pwx-witness/<name>.json (made if missing; back it up). State and
# evidence: ~/.local/share/pwx-witness/<name>.state.json.
set -eu
cd "$(dirname "$0")/.."
NAME=$1 PORT=$2 ORIGIN=$3 LOGKEY=$4 URL=$5
CONF=~/.config/pwx-witness; DATA=~/.local/share/pwx-witness; APP=$DATA/app
mkdir -p "$CONF" "$DATA" "$APP"; chmod 700 "$CONF"
KEY="$CONF/${NAME%%.*}.json"
[ -f "$KEY" ] || node -e 'const s=require("crypto").webcrypto.subtle; s.generateKey({name:"Ed25519"},true,["sign"]).then(k=>s.exportKey("jwk",k.privateKey)).then(j=>require("fs").writeFileSync(process.argv[1],JSON.stringify(j),{mode:0o600}))' "$KEY"
rsync -a --delete --include='/lib/***' --include='/log/***' --include='/signer/' --include='/signer/approval.mjs' --exclude='*' ./ "$APP/"
node -e '
  const [name, key, state, port, origin, logKey, url, out] = process.argv.slice(1);
  require("fs").writeFileSync(out, JSON.stringify({ name, key, state, port: Number(port), host: "127.0.0.1", skewSeconds: 300,
    logs: [{ origin, key: logKey, url }] }, null, 2));
' "$NAME" "$KEY" "$DATA/$NAME.state.json" "$PORT" "$ORIGIN" "$LOGKEY" "$URL" "$CONF/$NAME.config.json"
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/pwx-witness.service <<EOF
[Unit]
Description=PWX log witness $NAME (c2sp.org/tlog-witness) on 127.0.0.1:$PORT

[Service]
ExecStart=$(command -v node) $APP/log/witness-service.mjs $CONF/$NAME.config.json
Restart=on-failure
NoNewPrivileges=yes

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now pwx-witness.service >/dev/null
systemctl --user restart pwx-witness.service
sleep 1
curl -s "http://127.0.0.1:$PORT/"
