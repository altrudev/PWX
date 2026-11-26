#!/usr/bin/env bash
# Deploys the signed release to the live demo, with Notes logged in the public log.
#   bash tools/deploy-demo.sh            (from spike/, on the VPS, after pin/build/make-release)
# 1. Logs the Notes release in the public log (~/pwx-log/www; a no-op if already logged).
# 2. Uploads the log to https://pwx.altru.dev/log/, then asks the witness to co-sign it: the
#    witness reads the new entries from that public address for its clock check.
#    Then writes the release status list (withdrawals and revocations) and uploads it with the log.
# 3. Adds the public-log receipt to Notes, builds the site (log included) and uploads it.
# 4. Runs the live demo test in all three engines.
set -euo pipefail
cd "$(dirname "$0")/.."
SITE=https://pwx.altru.dev; ORIGIN=pwx.altru.dev/log; LOG=~/pwx-log/www; WITNESS=http://127.0.0.1:8190/
export PWX_LOG_KEY=public-log-key.json
mkdir -p ~/pwx-log
[ -f "$LOG/checkpoint" ] || node tools/pwx-log.mjs init "$LOG" "$ORIGIN"
node tools/pwx-log.mjs release "$LOG" "$ORIGIN" packages/notes.pwx.json ~/.config/pwx-dev/dev-key.json
rsync -a --exclude='.*' "$LOG/" whc:pwx.altru.dev/log/
node tools/pwx-log.mjs publish "$LOG" "$ORIGIN" "$WITNESS"
rsync -a --exclude='.*' "$LOG/" whc:pwx.altru.dev/log/
node --input-type=module -e "import { publicTrust } from './log/devlog.mjs'; console.log(JSON.stringify(await publicTrust()))" > /tmp/pwx-public-trust.json
# The release status list loaders download whole (M4 5a): withdrawals and revocations, with proofs.
node tools/pwx-log.mjs status "$LOG" /tmp/pwx-public-trust.json
rsync -a --exclude='.*' "$LOG/" whc:pwx.altru.dev/log/
rm -rf /tmp/pwx-pkgs && mkdir -p /tmp/pwx-pkgs
node tools/pwx-log.mjs receipt "$LOG" /tmp/pwx-public-trust.json packages/notes.pwx.json /tmp/pwx-pkgs/notes.pwx.json
rm -rf /tmp/pwx-site
PWX_SITE_PACKAGES=/tmp/pwx-pkgs PWX_PUBLIC_LOG="$LOG" node tools/build-site.mjs "$SITE" /tmp/pwx-site
rsync -a --delete /tmp/pwx-site/loader/ whc:pwx.altru.dev/
rsync -a --delete /tmp/pwx-site/apps/ whc:pwx-apps.altru.dev/
for b in chromium firefox webkit; do .venv/bin/python tests/live_demo_test.py --browser "$b" | tail -1; done
