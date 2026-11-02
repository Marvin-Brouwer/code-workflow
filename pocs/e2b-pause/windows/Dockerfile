# E2B Embed for Windows: a Linux host with its own Docker Engine, run by Docker Desktop.
#
# Embed's setup containers treat the Docker host as theirs: they nsenter into PID 1, check for glibc
# and the tools the orchestrator runs (iptables, rsync, e2fsprogs, iproute2), load nbd, and reserve
# hugepages. Under Docker Desktop that host is Desktop's own VM, whose root disk is too small. Inside
# this container, the host is this container, so it is the Ubuntu 24.04 host Embed is built for, with
# Docker Engine installed the way Docker documents it for Ubuntu.
FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl e2fsprogs iproute2 iptables kmod rsync \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
        > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Docker's own wrapper for running dockerd in a container: mounts securityfs and sets up cgroup v2
# nesting, so the containers Embed starts get working cgroups.
COPY --from=docker:29.8.2-dind /usr/local/bin/dind /usr/local/bin/dind

COPY entrypoint.sh /usr/local/bin/embed-entrypoint.sh
RUN chmod +x /usr/local/bin/embed-entrypoint.sh

WORKDIR /embed
ENTRYPOINT ["/usr/local/bin/embed-entrypoint.sh"]
