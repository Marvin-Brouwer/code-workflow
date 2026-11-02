#!/usr/bin/env bash
# Starts Docker Engine, then E2B Embed on it, and writes the SDK settings to /out/sdk.env.
set -euo pipefail

embed_ref="${EMBED_REF:-main}"

dind dockerd >/var/log/dockerd.log 2>&1 &
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

if ! docker compose up -d --wait; then
    # Compose only says which service failed; the reason is in that service's own log.
    echo "embed: Embed failed to start. Logs of the services that exited with an error:" >&2
    docker compose ps -a --format '{{.Service}} {{.ExitCode}}' | while read -r service code; do
        [ "$code" != 0 ] || continue
        echo "----- $service (exit $code)" >&2
        docker compose logs --no-color --no-log-prefix --tail 50 "$service" >&2
    done
    # Docker Engine stays up, so the inner stack can be inspected or retried with
    # `docker compose exec -T embed docker compose ...`.
    echo "embed: Docker Engine left running for inspection; 'docker compose restart' retries" >&2
    wait "$dockerd_pid"
    exit 1
fi
docker compose exec -T ready cat /run/e2b/sdk.env > /out/sdk.env
echo "embed: E2B is up; SDK settings written to pocs/e2b-pause/.work/sdk.env"

wait "$dockerd_pid"
