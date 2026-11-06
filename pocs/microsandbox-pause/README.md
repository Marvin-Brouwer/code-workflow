# @pocs/microsandbox-pause

**Outcome: ✅ adopted as the local backend where a hypervisor is usable** (2026-11-06). On NixOS on WSL (2026-11-06), a full snapshot kept memory
and processes: a pending `await` resolved in the same process and stack after 60 s paused, and again
after `wsl --shutdown` (6 minutes later). Egress to an allowlist works, but only with TLS
interception. Installed by `pnpm install` alone. See [Findings](#findings).

Same question, stub and criteria as [`../e2b-pause`](../e2b-pause/README.md)
([plan](../../docs/plans/poc-e2b-pause.md)), through the shared [`../pause-harness`](../pause-harness/README.md),
with [microsandbox](https://github.com/superradcompany/microsandbox) instead of E2B and no Docker.

## What it uses

- **The `microsandbox` npm package** (pinned to 0.7.13, Apache-2.0). It ships the `msb` runtime and
  `libkrunfw` as per-platform optional dependencies, so `pnpm install` is the whole install: no
  daemon, no Docker, nothing system-wide. microVMs on libkrun: KVM on Linux, Hypervisor.framework on
  macOS, Windows Hypervisor Platform on Windows (preview).
- **Pause = full snapshot, then remove the sandbox.**
  `Snapshot.builder(name).fromSandbox(sandbox).full().create()` saves disk, memory and running
  processes under `~/.microsandbox`; the sandbox is then killed and removed, so nothing of it runs.
  `sandbox.pause()` also exists, but only suspends the VM in place and isn't durable.
- **Resume = restore into a new sandbox.** `Sandbox.restore(reference).cpus(…).memory(…).restore()`,
  with the same CPU and memory settings as the capture, which a full restore requires. Execution
  continues where the snapshot was taken; the image's start command doesn't run again.
- **Egress**: microsandbox's own network policy, deny by default with DNS and one domain allowed.

## Prerequisites

Node 22+ and pnpm 10, plus one of these. Check with `pnpm --filter @pocs/microsandbox-pause exec msb doctor`.

- **NixOS on WSL**: `/dev/kvm`, which you already have from the E2B POC (`.wslconfig` with
  `nestedVirtualization=true` and `loadKernelModules=kvm_intel`). The bundled `msb` is a normal
  dynamically linked glibc binary, so NixOS needs `programs.nix-ld.enable = true;` to run it.
  No Docker.
- **Linux**: `/dev/kvm` and your user in the `kvm` group.
- **Windows, natively** (no WSL): enable the Windows Hypervisor Platform, which needs an admin and
  a reboot on a managed PC:
  `Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart`.
  The host usage check isn't measured there (no `ps`).

## Run

From the repo root:

```bash
pnpm install
pnpm poc:microsandbox-pause run      # start, pause for 60 s (POC_PAUSE_SECONDS), resume, verify
pnpm poc:microsandbox-pause pause    # start and pause, then restart WSL or the machine
pnpm poc:microsandbox-pause resume   # resume the sandbox from the pause step and verify
pnpm poc:microsandbox-pause egress   # allowlist one host (POC_EGRESS_ALLOWED), check another is blocked
```

The first run pulls `node:22-slim` (`POC_IMAGE` to change it). Each command prints one line per check
and writes the full report to `.work/report-<command>-<time>.json`. Snapshots stay in
`~/.microsandbox/snapshots`; `msb snap ls` lists them and `msb snap rm` removes them.

## Findings

Ran 2026-11-06 on NixOS on WSL (Marvin's dev machine, AMD, `/dev/kvm` world-writable, nix-ld
already enabled), microsandbox 0.7.13 from npm, `node:22-slim`. `msb doctor` was green without any
change to the machine.

| Criterion | Result |
|---|---|
| Pending `await` resolves after resume, same PID, memory and stack | ✅ PID 468 → 468, token and 500 MB checksum unchanged, `input`/`loop`/`workflow` frames intact, after 66 s waiting |
| No CPU or RAM on the host while paused | ✅ msb processes 1 → 0, RSS 657 → 0 MB |
| Survives a restart | ✅ `pause`, `wsl --shutdown`, `resume`: same PID, memory and stack after 375 s |
| Runs on a machine used for development | ✅ NixOS on WSL, nothing installed beyond `pnpm install`; native Windows not tried |
| Egress limited to an allowlist (should) | ✅ with TLS interception: `registry.npmjs.org` → 200, `example.com` → refused by microsandbox's proxy (403, `network_policy_denied`) |

Measured:

| What | Value |
|---|---|
| Start (image cached) | 650–810 ms; 3.2 s the first time |
| Pause (full snapshot, 500 MB in use, 1 GiB VM) | 0.9–1.9 s |
| Resume | 750 ms; 670 ms after `wsl --shutdown` |

Observations that matter for the engine:

- **No managed jobs during a capture.** A full snapshot is refused while a job started with
  `execDetached` runs ("full capture and fork are unavailable while managed jobs are active"). The
  stub is started with `setsid -f` from a shell instead. The engine's runtime would be started the
  same way, or as the sandbox's own process.
- **Hostname allowlists need TLS interception.** In strict hostname mode, the default, HTTPS allowed
  only by a hostname rule is reset unless microsandbox can read the request's host, which means it
  terminates TLS with its own CA (`interceptTls()`; Node needs `--use-system-ca` to trust it). That
  is a TLS-intercepting proxy in the sandbox's path, which the gateway design doesn't need: a
  gateway-only egress could be an IP rule to the gateway instead. `strict(false)` would allow by
  SNI without interception, which is weaker.
- **A blocked HTTPS request gets an HTTP answer** from that proxy (403 with
  `{"code":"network_policy_denied"}`), not a reset; a blocked plain connection is refused.
- **Clock**: see the reports' `clock` section; not yet compared with E2B and gVisor.
- **Not measured on Windows natively** (Windows Hypervisor Platform), which is the one thing only
  microsandbox offers here.

Not done: native Windows, the open-stream measurement, and a longer pause.
