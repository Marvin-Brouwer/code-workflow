# @pocs/gvisor-pause

**Outcome: ✅ adopted as the local backend without a hypervisor** (2026-11-06). On NixOS on WSL, and in a Linux cloud container
without KVM, gVisor's `runsc checkpoint` / `runsc restore` kept memory and processes: a pending
`await` resolved in the same process and stack after 60 s paused, and again after a `wsl --shutdown`.
Egress through a gateway socket with an allowlist passes on both. Adoption still to decide. See
[Findings](#findings).

Same question, stub and criteria as [`../e2b-pause`](../e2b-pause/README.md)
([plan](../../docs/plans/poc-e2b-pause.md)), through the shared [`../pause-harness`](../pause-harness/README.md),
with gVisor instead of E2B and no Docker.

## What it uses

- **[gVisor](https://gvisor.dev)'s `runsc`**: one static Go binary. A user-space kernel (the
  Sentry) intercepts the sandbox's system calls, so the workload never talks to the host kernel
  directly. Weaker isolation than a microVM, much stronger than a container. **No KVM needed**: the
  default `systrap` platform works without `/dev/kvm`; `POC_RUNSC_PLATFORM=kvm` uses it where it
  exists.
- **Checkpoint/restore** ([docs](https://gvisor.dev/docs/user_guide/checkpoint_restore/)):
  `runsc checkpoint --image-path=<dir> <id>` writes memory, processes and the sandbox's in-memory
  filesystem to `<dir>` and ends the sandbox; `runsc restore --image-path=<dir> --bundle=<bundle> <new id>`
  brings it back in a new container.
- **No Docker**: [`src/image.ts`](src/image.ts) pulls `node:22-slim` from Docker Hub and unpacks it
  into `.work/rootfs` (layers in order, whiteouts applied). [`src/host.ts`](src/host.ts) writes an
  OCI bundle around it with `runsc spec`.
- **No network** (`--network=none`): the sandbox has only loopback. Its one way out is a Unix
  socket bind-mounted from the host, [`src/gateway.ts`](src/gateway.ts): an HTTP CONNECT proxy that
  tunnels only to allowed hosts. That is the shape the engine's gateway would have, without
  iptables, tap devices or bridges.

## Prerequisites

Linux, root (runsc needs it to set up the sandbox), Node 22+ and pnpm 10.

- **NixOS** (also on WSL): add `pkgs.gvisor` to `environment.systemPackages`. Nothing else: no
  Docker, no KVM, no nested virtualization, no `.wslconfig` changes.
- **Other Linux**: download `runsc` from gVisor's releases
  ([install docs](https://gvisor.dev/docs/user_guide/install/)) and put it on the `PATH`.
- **Windows**: inside a WSL distro only; gVisor doesn't run on Windows itself.

Run the POC as your user with `RUNSC='sudo runsc'`, or as root. The checkpoints and runsc's state in
`.work` are then owned by root; `sudo rm -rf pocs/gvisor-pause/.work` cleans up.

## Run

From the repo root:

```bash
pnpm install
export RUNSC='sudo runsc'       # unless you're root
pnpm poc:gvisor-pause run       # start, pause for 60 s (POC_PAUSE_SECONDS), resume, verify
pnpm poc:gvisor-pause pause     # start and pause, then restart WSL or the machine
pnpm poc:gvisor-pause resume    # resume the sandbox from the pause step and verify
pnpm poc:gvisor-pause egress    # allowlist one host (POC_EGRESS_ALLOWED), check another is blocked
```

The first run pulls the image into `.work/rootfs` (about 230 MB unpacked). Each command prints one line per
check and writes the full report to `.work/report-<command>-<time>.json`.

Behind a TLS-intercepting proxy (as in the cloud container this was tested in), set
`NODE_USE_ENV_PROXY=1` so the image pull uses `HTTPS_PROXY`, and `POC_SANDBOX_CA=<ca file>` so the
egress probe inside the sandbox trusts the proxy's CA. The gateway tunnels through `HTTPS_PROXY`
itself.

## Findings

Ran 2026-11-06 on NixOS on WSL (Marvin's dev machine, runsc from nixpkgs through `sudo`, `systrap`),
and in a Linux cloud container (kernel 6.18, 4 vCPUs, 15 GiB RAM, **no `/dev/kvm`**) as root with runsc
`release-20260714.0` on `systrap`. Both with `node:22-slim` (Node 22).

| Criterion | Result |
|---|---|
| Pending `await` resolves after resume, same PID, memory and stack | ✅ PID 2 → 2, token and 500 MB checksum unchanged, `input`/`loop`/`workflow` frames intact, after 68 s waiting |
| No CPU or RAM on the host while paused | ✅ runsc processes (sentry and gofer) 2 → 0 |
| Survives a restart | ✅ NixOS: `pause`, `wsl --shutdown`, `resume`: same PID, memory and stack after 84 s. Container: same after deleting runsc's whole state directory |
| Runs on a machine used for development | ✅ NixOS on WSL with `nix shell nixpkgs#gvisor` and `RUNSC="sudo $(command -v runsc)"`; no Docker, no config change |
| Egress limited to an allowlist (should) | ✅ container: through the gateway socket, `registry.npmjs.org` → 200, `example.com` → refused by the gateway; a direct request without the gateway fails (no network). ✅ NixOS: the same, after making the socket world-writable (created by a normal user, runsc's gofer couldn't connect to it) |

Measured:

| What | NixOS on WSL | Cloud container |
|---|---|---|
| Start (rootfs cached) | 210–240 ms | 120–175 ms |
| Pause (checkpoint of a sandbox with 500 MB in use) | 370–410 ms | 3.7–4.2 s |
| Resume | 570 ms; 490 ms after `wsl --shutdown` | 280–290 ms; 830 ms once |
| Checkpoint size | | 539 MB for 500 MB of ballast, uncompressed (`pages.img` is the memory) |

Observations that matter for the engine:

- **Timers count paused time here, unlike E2B.** A 30 s `setTimeout` scheduled before a 60 s pause
  fired right after resume (at 67.8 s). In E2B the same timer didn't fire, because Firecracker
  stops the guest's monotonic clock. So timer behaviour across a pause depends on the backend, which
  confirms the E2B finding's rule: wall-clock waits are engine-side wake-ups, and nothing in the
  sandbox may rely on what a timer does across a pause.
- **`Date.now()` jumps to real time after resume** (largest tick gap 64.8 s for a 60 s pause), as
  in E2B.
- **Pause time is disk speed.** runsc writes all memory to the checkpoint before it returns: 0.4 s
  on the dev machine, 4 s on the cloud container's slower disk (E2B: 0.1 s). Fine for waits on
  humans either way; `--compression` and `--exclude-committed-zero-pages` make the image smaller.
- **The stub must not be the container's init.** When the container's first process exits, the
  container stops. The bundle runs `sh -c 'node stub.mjs; exec sleep infinity'`; the engine's
  runtime would be a long-lived process anyway.
- **Writes inside the sandbox stay in the checkpoint.** The rootfs directory on the host is never
  written: gVisor's default overlay keeps changes in memory, so they are saved and restored with it.
  Repository checkouts of gigabytes would make checkpoints that size; a disk-backed overlay
  (`--overlay2=root:self`) is the knob to look at.
- **Restore needs the same bundle and rootfs**, and a host CPU with the same or more features.
- **No daemon, no idle cost**: between runs nothing of gVisor runs. Compare Embed's 0.25 core idle.

Not done: the open-stream measurement, and a longer pause (hours or
days).
