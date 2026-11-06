# @pocs/microsandbox-pause

**Outcome: ⏳ not run yet.** Needs `/dev/kvm` (Linux, WSL) or the Windows Hypervisor Platform,
which the cloud container this was written in doesn't have. Type-checked and linted only; `msb
doctor` runs and reports the missing KVM. See [Findings](#findings).

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

Not run yet. What's known from the docs and the package:

- Full snapshots are documented as "Disk, memory, and running processes" → "Resumes execution", and
  are local only (microsandbox's cloud only does disk snapshots).
- Restoring after a host restart isn't stated anywhere; the `pause` / restart / `resume` sequence is
  what settles it.
- Clock: by default the host sets the guest clock on restore and the monotonic clock "continues
  from the snapshot", which predicts E2B's behaviour (timers don't count paused time), not
  gVisor's. The report's `clock` section shows which.
- Open connections aren't captured: "Reconnect clients and application connections".
- Windows support is marked preview; snapshots taken there before the PIT-timer fix are rejected.

Written against the 0.7.13 type definitions, not run: if an SDK call behaves differently from its
types (for example removing a killed sandbox, or the network policy builder), fixing that is part
of the first run.
