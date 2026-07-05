#!/usr/bin/env bash
# Run ON THE VM HOST (via Cloud Shell SSH), same box that runs the jarvis-caddy
# container. Adds cutout.syncster.dev to the existing Caddy reverse proxy and
# hot-reloads it (no downtime for jarvis/chat). Cutout serves on :8092 inside
# the gateway container.
set -euo pipefail

DOMAIN="cutout.syncster.dev"
PORT="8092"
CADDYFILE="$HOME/jarvis-caddy/Caddyfile"

GW=$(docker ps --format '{{.Names}}' | grep -i gateway | head -1)
[ -n "$GW" ] || { echo "!! gateway container not found"; docker ps; exit 1; }
echo "gateway container: $GW"

[ -f "$CADDYFILE" ] || { echo "!! $CADDYFILE not found (is jarvis-caddy set up?)"; exit 1; }

if grep -q "$DOMAIN" "$CADDYFILE"; then
  echo "== $DOMAIN already present in Caddyfile; leaving it as-is."
else
  cat >> "$CADDYFILE" <<EOF

${DOMAIN} {
	reverse_proxy ${GW}:${PORT}
	encode gzip
}
EOF
  echo "== appended ${DOMAIN} block to $CADDYFILE"
fi

# Hot-reload Caddy inside the running container (no restart, no dropped conns).
docker exec jarvis-caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null \
  || { echo "reload via exec failed, restarting container"; docker restart jarvis-caddy; }

echo "--- caddy logs ---"
sleep 2
docker logs --tail 15 jarvis-caddy
echo
echo ">> Once DNS for ${DOMAIN} -> this VM's IP, Caddy auto-issues TLS."
echo ">> Test: curl -I https://${DOMAIN}/healthz"
