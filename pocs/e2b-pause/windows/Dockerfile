# E2B Embed for Windows: a Linux host with its own Docker Engine, run by Docker Desktop.
#
# Embed's setup containers treat the Docker host as theirs (nsenter into PID 1, hugepages, NBD
# devices, snapshots in /var/lib/e2b). Under Docker Desktop that host is Desktop's own VM, whose
# root disk is too small. Inside this container, the host is this container instead.
FROM docker:29.8.2-dind

RUN apk add --no-cache bash curl kmod

COPY entrypoint.sh /usr/local/bin/embed-entrypoint.sh
RUN chmod +x /usr/local/bin/embed-entrypoint.sh

WORKDIR /embed
ENTRYPOINT ["/usr/local/bin/embed-entrypoint.sh"]
