#!/usr/bin/env bash
# Starts Docker Engine, then E2B Embed on it, and writes the SDK settings to /out/sdk.env.
set -euo pipefail

embed_ref="${EMBED_REF:-main}"

# The container's filesystem survives a restart, so after an unclean stop (WSL or Docker Desktop
# shutting down) the old pid files are still there and dockerd refuses to start, because their PIDs
# now belong to other processes. Nothing else runs dockerd or containerd in this container.
rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid

# This container sits on a Docker Desktop network in 172.16.0.0/12, the same range the inner Docker
# Engine would pick for Embed's network by default. An inner network on this container's own
# subnet takes over its gateway address and breaks both outbound traffic and traffic between
# Embed's containers, so the inner engine gets addresses from a range Docker Desktop doesn't use.
dind dockerd \
    --bip 10.213.255.1/24 \
    --default-address-pool base=10.213.0.0/17,size=24 \
    >/var/log/dockerd.log 2>&1 &
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
# On a Linux host the files would stay root's, so the host script couldn't write its reports next to
# them. Docker Desktop on Windows ignores ownership, hence the || true.
chown -R "$(stat -c %u:%g /owner)" /out 2>/dev/null || true
echo "embed: E2B is up; SDK settings written to pocs/e2b-pause/.work/sdk.env"

wait "$dockerd_pid"
