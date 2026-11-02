# @pocs/e2b-pause

**Outcome: ⏳ not run yet.** The POC is built, and its sandbox stub is tested locally, but it
needs a machine with `/dev/kvm`. The cloud container it was written in has none. Fill in
[Findings](#findings) after the first run.

Plan and criteria: [docs/plans/poc-e2b-pause.md](../../docs/plans/poc-e2b-pause.md).

## Step 0: what self-hosting needs

Researched 2026-10-30. Self-hosted E2B on one machine is **E2B Embed**, the open-source stack
(Apache-2.0) run with Docker Compose
([hub](https://github.com/e2b-dev/runtime/blob/main/embed/README.md),
[Compose guide](https://github.com/e2b-dev/runtime/blob/main/embed/compose/README.md)). The Compose
guide calls it "a single-machine evaluation package rather than a deployment pattern".

| Requirement | From the Compose guide |
|---|---|
| OS | Linux x86-64 or arm64 with KVM and a 4 KiB-page kernel; Ubuntu 24.04 recommended, kernel 6.8+, cgroup v2 |
| Virtualization | `/dev/kvm` and `/dev/net/tun`; bare metal, or a VM with nested virtualization |
| Docker | Engine 27+, Compose 2.24+, your user in the `docker` group |
| Resources | 12 GiB RAM recommended, 20 GiB free disk |
| Network | outbound HTTPS to Docker Hub, `us-docker.pkg.dev`, `storage.googleapis.com`, `github.com`, `raw.githubusercontent.com` |

What that means for this POC:

- **WSL2 isn't mentioned anywhere** in the Embed docs, so NixOS on WSL2 is unverified. It needs
  nested virtualization for `/dev/kvm`, and the docs' "Ubuntu recommended" leaves NixOS as
  something to try, not a supported path. Try it first; fall back to an Ubuntu 24.04 VM or box.
- **Pause with memory is the default**: `sandbox.pause()` saves memory and filesystem, and
  `Sandbox.connect(id)` resumes
  ([persistence docs](https://docs.e2b.dev/sandbox/persistence)). The docs give about 4 s per GiB
  of RAM to pause and about 1 s to resume, and say paused sandboxes are kept indefinitely. The
  Embed docs show pause and resume working and state no self-hosted caveat.
- **Filesystem-only pause** exists as an explicit option, and E2B Cloud falls back to it when a
  node keeps refusing a memory auto-pause. This POC uses explicit pauses and checks memory after
  resume, so a silent fallback would show up as a failed "same process" check.
- **Restart risk:** the Compose guide says running sandboxes end when the orchestrator restarts. It
  says nothing about paused ones. That's exactly the "survives a restart" criterion, so the POC
  tests it with the `pause` and `resume` commands below.
- **Embed is plain HTTP** with no TLS, and its orchestrator API on port 5008 is unauthenticated.
  Only expose 3000 and 3002 to trusted clients.
- The Embed docs are tested with the 2.46 SDK line, so this POC pins `e2b@~2.46.1`.

## Prerequisites per setup

Docker has to run in the same Linux that has `/dev/kvm`, because Embed's containers use
`/dev/kvm` and `/dev/net/tun` from their own host.

**NixOS on WSL2**

- Run Docker Engine inside NixOS (`virtualisation.docker.enable = true;`, with your user in the
  `docker` group). Don't use Docker Desktop's WSL integration: that runs containers in its own
  `docker-desktop` distro, so it doesn't test NixOS.
- `ls -l /dev/kvm /dev/net/tun` must show both. If `/dev/kvm` is missing, add
  `nestedVirtualization=true` under `[wsl2]` in `%UserProfile%\.wslconfig`, then run `wsl --shutdown`.
- `uname -r` must be 6.8 or newer. The stock WSL2 kernel has been on the 6.6 line, which may be the
  first blocker; the fallback is a custom WSL kernel or an Ubuntu 24.04 VM.
- Docker 27+, Compose 2.24+, cgroup v2, and about 12 GiB RAM for WSL (`memory=` in `.wslconfig`).

**Windows with Docker Desktop**

- Docker Desktop runs on the same WSL2 kernel, so the `/dev/kvm`, `.wslconfig` and kernel checks
  above apply too. Run them in the `docker-desktop` distro, or in a container started with
  `--device /dev/kvm`.
- Run from Git Bash with `export MSYS_NO_PATHCONV=1`, or it rewrites `/dev/kvm` into a Windows
  path.
- Seen on 2026-11-02: after `wsl --update` (WSL 3.0.3, kernel 6.18) the CPU flags were visible
  but `/dev/kvm` was missing, with or without `nestedVirtualization=true`. Loading the module in
  Docker Desktop's VM fixed it, until the next `wsl --shutdown` or Docker Desktop restart:
  `docker run --rm --privileged --pid=host alpine nsenter -t 1 -m -- sh -c "modprobe kvm_intel || modprobe kvm_amd"`.
- Firecracker runs inside Docker Desktop's VM, where the host script can't see it. The "no CPU or
  RAM while paused" check reports "not measured"; every other check still works.

## Run

On the E2B host (the host checks read local `firecracker` processes, so run it on the machine
that runs Embed):

```bash
# once: start E2B Embed
mkdir e2b && cd e2b
curl -fsSL --remote-name-all "https://raw.githubusercontent.com/e2b-dev/runtime/main/embed/compose/{compose.yaml,.env}"
docker compose up -d --wait

# in each shell that runs the POC: point the SDK at Embed
eval "$(docker compose exec ready cat /run/e2b/sdk.env)"
```

Then from the repo root:

```bash
pnpm poc:e2b-pause run      # start, pause for 60 s (POC_PAUSE_SECONDS), resume, verify
pnpm poc:e2b-pause pause    # start and pause, then restart E2B:  docker compose restart
pnpm poc:e2b-pause resume   # resume the sandbox from the pause step and verify
pnpm poc:e2b-pause egress   # allowlist one host (POC_EGRESS_ALLOWED), check another is blocked
```

Each run prints one line per check and writes the full report, including timings and the stack
after resume, to `pocs/e2b-pause/.work/report-<command>-<time>.json`. Set `E2B_SNAPSHOT_DIR` to
Embed's snapshot storage to also record the snapshot size.

## How it works

- [`src/stub.mjs`](src/stub.mjs) runs in the sandbox on its own Node. It's a fake workflow with a
  real async stack, `workflow → loop → input()`. Before waiting it fills a ballast buffer (half
  the sandbox's RAM, at most 500 MB), and writes its PID, a random token, the buffer's checksum and
  its stack to `waiting.json`. Then it polls for `answer.json`. No connection is open while it
  waits, as the design's rule says.
- [`src/host.ts`](src/host.ts) creates the sandbox, starts the stub, pauses, resumes with
  `Sandbox.connect`, writes the answer and reads `done.json`.
- **Success checks:** the stub's PID is still alive after resume; the await resolves; same PID,
  token and checksum; `input`, `async loop` and `async workflow` frames in the stack taken after
  the await; fewer firecracker processes on the host while paused. Run `pause`, restart, then
  `resume` for the restart criterion.
- **Recorded, not pass/fail:** create, pause and resume times; snapshot size; the largest gap
  between the stub's one-second ticks (a gap near the pause length means `Date.now()` jumped);
  when a 30 s timeout scheduled before the pause fired; what happened to an HTTP stream from the
  host to the stub (`GET /ticks`) that was open during the pause.

Tested in the cloud container: `tsc` and ESLint pass, the stub's file protocol works under local
Node (same PID, token and checksum, and the expected stack frames), and without credentials the
host stops at the SDK's `AuthenticationError`. Nothing touched a real E2B yet.

## Findings

Not run yet. Record here: the machine and OS used, each check's line from the output, the
timings, the restart result, and the clock and stream observations. Then set the outcome at the
top to ✅ or ❌.
