#!/usr/bin/env bash
# Starts Docker Engine, then E2B Embed on it, and writes the SDK settings to /out/sdk.env.
set -euo pipefail

embed_ref="${EMBED_REF:-main}"

dockerd-entrypoint.sh dockerd >/var/log/dockerd.log 2>&1 &
dockerd_pid=$!

stop() {
    echo "embed: stopping Embed and Docker Engine"
    docker compose stop || true
    kill -TERM "$dockerd_pid" 2>/dev/null || true
    wait "$dockerd_pid" || true
    exit 0
}
trap stop TERM INT

until docker info >/dev/null 2>&1; do
    kill -0 "$dockerd_pid" 2>/dev/null || { echo "embed: dockerd exited, see /var/log/dockerd.log" >&2; tail -n 50 /var/log/dockerd.log >&2; exit 1; }
    sleep 1
done
echo "embed: Docker Engine is up"

if [ ! -s compose.yaml ] || [ ! -s .env ]; then
    echo "embed: fetching Embed's compose.yaml and .env from e2b-dev/runtime@${embed_ref}"
    curl -fsSL --remote-name-all "https://raw.githubusercontent.com/e2b-dev/runtime/${embed_ref}/embed/compose/{compose.yaml,.env}"
fi

docker compose up -d --wait
docker compose exec -T ready cat /run/e2b/sdk.env > /out/sdk.env
echo "embed: E2B is up; SDK settings written to pocs/e2b-pause/.work/sdk.env"

wait "$dockerd_pid"
