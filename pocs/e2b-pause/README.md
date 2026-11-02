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

- **WSL2 isn't mentioned anywhere** in the Embed docs. On Windows 11 with Docker Desktop, WSL 3
  gives a 6.18 kernel and a working `/dev/kvm` once configured (see
  [Prerequisites](#prerequisites-per-setup)). NixOS on that VM is still unverified; the fallback
  is an Ubuntu 24.04 VM or box.
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
`/dev/kvm` and `/dev/net/tun` from their own host. Every setup needs Node 22+ and pnpm 10
(`corepack enable`) to run the host script, and about 12 GiB RAM and 20 GiB disk for Embed.

### Windows with Docker Desktop

Checked 2026-11-02 on Windows 11 with an Intel CPU, Docker Desktop on the WSL2 backend, WSL 3.0.3
and kernel 6.18.54.1.

1. **Install** Docker Desktop with the WSL2 backend, Git for Windows (Git Bash), and Node 22+.
   Windows 11 on x86-64 is required; nested virtualization doesn't work on Windows 10 or arm64.
   Embed's preflight wants 20 GiB free inside Docker's disk: raise Docker Desktop → Settings →
   Resources → Advanced → *Virtual disk limit* (64 GB is comfortable), or `docker system prune`.
2. **Update WSL** from PowerShell or Git Bash: `wsl --update`. The old 5.15 kernel is below
   Embed's 6.8 minimum. A warning that `System.AppUserModel.ID` couldn't be set on `WSL.lnk` is
   harmless.
3. **Find your CPU vendor**, after starting Docker Desktop:
   `docker run --rm alpine grep -m1 -oE 'vmx|svm' /proc/cpuinfo`. `vmx` is Intel, `svm` is AMD.
4. **Configure WSL** in `%UserProfile%\.wslconfig`. Since WSL 3, KVM is a kernel module that isn't
   loaded at boot, so `/dev/kvm` is missing until you load it here. `.wslconfig` applies to the
   one VM all WSL distros share, Docker Desktop's included. Use `kvm_amd` for `svm`, and give
   WSL at least 12GB of memory.

   ```ini
   [wsl2]
   nestedVirtualization=true
   loadKernelModules=kvm_intel
   memory=16GB
   ```

5. **Restart WSL**: `wsl --shutdown`, then start Docker Desktop again.
6. **Use Git Bash, with path conversion off**, for everything below. Without it, Git Bash rewrites
   `/dev/kvm` and `/run/e2b/...` into Windows paths.

   ```bash
   export MSYS_NO_PATHCONV=1
   ```

7. **Check**: both devices must be listed, and the kernel must be 6.8 or newer.

   ```bash
   docker run --rm --device /dev/kvm --device /dev/net/tun alpine sh -c "ls -l /dev/kvm /dev/net/tun; uname -r"
   ```

Then continue with [Run](#run), in the same Git Bash session. Two things differ from Linux:

- Firecracker runs inside Docker Desktop's VM, where the host script can't see it. The "no CPU or
  RAM while paused" check reports "not measured"; every other check still works.
- The repo's `.npmrc` pins the public npm registry, so a company registry in your user-level npm
  config doesn't apply here.

### NixOS on WSL2

- Run Docker Engine inside NixOS (`virtualisation.docker.enable = true;`, with your user in the
  `docker` group). Don't use Docker Desktop's WSL integration: that runs containers in its own
  `docker-desktop` distro, so it doesn't test NixOS.
- Steps 2 to 5 and 7 of the Windows setup apply too, because NixOS runs on the same WSL VM and
  kernel. Run the check inside NixOS (`ls -l /dev/kvm /dev/net/tun; uname -r`).
- Docker 27+, Compose 2.24+ and cgroup v2.

### Linux

Ubuntu 24.04 on bare metal, or a VM with nested virtualization, as in the Step 0 table above.

## Run

On the machine that runs Embed, since the host checks read local `firecracker` processes. On
Windows, use Git Bash with `MSYS_NO_PATHCONV=1` set, as above.

```bash
# once: start E2B Embed (the first start takes a few minutes)
mkdir -p ~/e2b && cd ~/e2b
curl -fsSL --remote-name-all "https://raw.githubusercontent.com/e2b-dev/runtime/main/embed/compose/{compose.yaml,.env}"
docker compose up -d --wait

# in each shell that runs the POC: point the SDK at Embed
eval "$(docker compose exec ready cat /run/e2b/sdk.env)"
```

Then from the repo root:

```bash
pnpm install
pnpm poc:e2b-pause run      # start, pause for 60 s (POC_PAUSE_SECONDS), resume, verify
pnpm poc:e2b-pause pause    # start and pause, then restart E2B:  (cd ~/e2b && docker compose restart)
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
