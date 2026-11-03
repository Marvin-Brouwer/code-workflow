# @pocs/e2b-pause

**Outcome: ⏳ passing so far, not adopted yet.** On self-hosted E2B (Embed), both in an Ubuntu WSL
distro and in the [`windows/`](windows/) container on Docker Desktop, a paused sandbox kept its
memory and processes: a pending `await` resolved in the same process and stack after 60 s paused,
and again after an Embed restart. Embed can't use Docker Desktop as its host directly; the
`windows/` container gives it one. Still to run: NixOS on WSL. See [Findings](#findings).

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

- **WSL2 isn't mentioned anywhere** in the Embed docs. It works in an Ubuntu 24.04 WSL distro
  with its own Docker Engine, but not on Docker Desktop directly (see
  [Prerequisites](#prerequisites-per-setup)).
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

### Windows with Docker Desktop: the `windows/` container

**Passed 2026-11-02**, see [Findings](#findings).

Embed can't run on Docker Desktop directly. It isn't a self-contained container app: its setup
containers `nsenter` into the host's PID 1, configure hugepages and NBD devices, and store templates
and snapshots in host paths (`/var/lib/e2b`, `/orchestrator`). Under Docker Desktop that host is
Desktop's internal VM, whose root disk had 8 GiB free with no setting to grow it, so the 20 GiB
preflight check fails.

[`windows/`](windows/) gives Embed a host of its own instead: a privileged container with its own
Docker Engine, which fetches and starts Embed inside itself. Because Embed's preflight runs in that
container's namespaces, the container is the Ubuntu 24.04 host Embed is built for (glibc, iptables,
rsync, e2fsprogs, iproute2), with Docker Engine from Docker's apt repository. An Alpine-based
`docker:dind` fails that preflight on glibc and the missing tools. Its disk is a Docker volume on
Desktop's large image disk.

1. **Requirements:** Windows 11 on x86-64 (nested virtualization doesn't work on Windows 10 or
   arm64), Docker Desktop on the WSL2 backend, Git Bash, Node 22+ and pnpm 10.
2. **Update WSL:** `wsl --update`. The old 5.15 kernel is below Embed's 6.8 minimum. A warning
   that `System.AppUserModel.ID` couldn't be set on `WSL.lnk` is harmless.
3. **Configure WSL** in `%UserProfile%\.wslconfig`. Since WSL 3, KVM is a kernel module that isn't
   loaded at boot, so `/dev/kvm` is missing until you load it here. Use `kvm_amd` on AMD
   (`docker run --rm alpine grep -m1 -oE 'vmx|svm' /proc/cpuinfo` prints `vmx` on Intel, `svm` on
   AMD), and give WSL at least 12GB of memory.

   ```ini
   [wsl2]
   nestedVirtualization=true
   loadKernelModules=kvm_intel
   memory=16GB
   ```

4. **Restart WSL:** `wsl --shutdown`, then start Docker Desktop.
5. **Start Embed** from the repo, in Git Bash. The first start pulls Embed's images inside the
   container and takes several minutes; it's ready when the log says `E2B is up`.

   ```bash
   cd pocs/e2b-pause/windows
   docker compose up -d --build
   docker compose logs -f   # Ctrl+C once it says "E2B is up"
   ```

6. **Run the POC** from the repo root, still in Git Bash. The host script picks up the SDK settings
   from `pocs/e2b-pause/.work/sdk.env`, which the container writes, so there's nothing to `eval`.

   ```bash
   pnpm install
   pnpm poc:e2b-pause run
   pnpm poc:e2b-pause pause
   (cd pocs/e2b-pause/windows && since=$(date -u +%FT%TZ) && docker compose restart \
     && until docker compose logs --since "$since" | grep -q "E2B is up"; do sleep 5; done)
   pnpm poc:e2b-pause resume
   pnpm poc:e2b-pause egress
   ```

   Restarting the container restarts Embed and its Docker Engine. Paused sandboxes live in the
   `e2b-data` and `orchestrator` volumes.

Differences from Linux: firecracker runs inside the container, where the host script can't see it,
so "no CPU or RAM while paused" reports "not measured". The repo's `.npmrc` pins the public npm
registry, so a company registry in a user-level npm config doesn't apply.

To remove everything: `docker compose down -v` in `pocs/e2b-pause/windows`.

### Windows: Ubuntu on WSL

Passed on 2026-11-02 on Windows 11 with an Intel CPU, WSL 3.0.3 and kernel 6.18.54.1. An Ubuntu
24.04 WSL distro with Docker Engine installed inside it. Do steps 1 to 3 above, then:

1. **Install Ubuntu and restart WSL:** `wsl --install -d Ubuntu-24.04`, then `wsl --shutdown`.
2. **Quit Docker Desktop** if it's installed. Its WSL integration takes over `docker` in your
   default distro while it runs.
3. **Open Ubuntu** (`wsl -d Ubuntu-24.04`) and do everything below in that shell, not in Git Bash
   or PowerShell. Install Docker Engine, Node 22 and pnpm:

   ```bash
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
   sudo corepack enable
   ```

4. **Check:** `docker info --format '{{.Name}} / {{.OperatingSystem}}'` names Ubuntu, not Docker
   Desktop; `ls -l /dev/kvm /dev/net/tun` lists both; `uname -r` is 6.8 or newer; `df -h /` has
   20G+ available.
5. **Clone the repo into the Linux filesystem** (`~`, not `/mnt/c`), then continue with
   [Run](#run).

The repo's `.npmrc` pins the public npm registry, so a company registry in a user-level npm config
doesn't apply.

### NixOS on WSL2

- Run Docker Engine inside NixOS (`virtualisation.docker.enable = true;`, with your user in the
  `docker` group). Don't use Docker Desktop's WSL integration: that runs containers in its own
  `docker-desktop` distro, so it doesn't test NixOS.
- Windows steps 1 to 3 apply too, and the checks of the Ubuntu setup, because NixOS runs on the
  same WSL VM and kernel.
- Docker 27+, Compose 2.24+ and cgroup v2.

### Linux

Ubuntu 24.04 on bare metal, or a VM with nested virtualization, as in the Step 0 table above.

## Run

On the machine that runs Embed, since the host checks read local `firecracker` processes. On
Windows, that's the Ubuntu shell.

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

Ran 2026-11-02 on Windows 11 (Intel, 16 threads), WSL 3.0.3 with kernel 6.18.54.1, an Ubuntu 24.04
distro with Docker Engine, and E2B Embed from `e2b-dev/runtime` main (orchestrator
`v0.16.202610201713`, Firecracker `v1.14`). The default sandbox template has 473 MB RAM and Node
20.9.0, so the stub used 236 MB of ballast.

The same run passed on the same PC in the [`windows/`](windows/) container on Docker Desktop, with
the same Embed version. The container needed three things to work: an Ubuntu 24.04 base rather than
Alpine `docker:dind` (Embed's preflight checks glibc and host tools in the container itself), the
`/etc` directories systemd and udev would normally create, and an inner address pool outside
172.16.0.0/12, because an inner network on the container's own Docker Desktop subnet breaks its
networking. The Firecracker host usage isn't measured there, because the processes live inside
the container.

| Criterion | Result |
|---|---|
| Pending `await` resolves after resume, same PID, memory and stack | ✅ PID 1518 → 1518, token and 236 MB checksum unchanged, `input`/`loop`/`workflow` frames intact, after 64 s waiting |
| No CPU or RAM on the host while paused | ✅ firecracker processes 1 → 0 |
| Survives a restart of the E2B service | ✅ `pause`, `docker compose restart`, `resume`: same PID, memory and stack, after 34 s waiting |
| Runs on a machine used for development | ✅ in an Ubuntu WSL distro, and on Docker Desktop through the `windows/` container (not on Docker Desktop directly); NixOS on WSL still to run, see [Prerequisites](#prerequisites-per-setup) |
| Egress limited to an allowlist (should) | ✅ `registry.npmjs.org` → 200, `example.com` blocked |
| Same script against E2B cloud (should) | not run |

Measured:

| What | Value |
|---|---|
| Create | 473 ms |
| Pause (236 MB in use, 473 MB VM) | 113 ms |
| Resume | 238 ms; 660 ms after an Embed restart |
| `windows/` container | create 373 ms, pause 91 ms, resume 212 ms; 649 ms after a container restart (Embed back up in 69 s) |
| Snapshot size | not measured (`E2B_SNAPSHOT_DIR` not set) |

Observations that matter for the engine:

- **`Date.now()` jumps to real time after resume.** The largest gap between the stub's one-second
  ticks was 61.2 s, about the pause length. Wall-clock time is right after a resume, so token
  expiry and deadlines based on `Date.now()` behave.
- **Timers don't count paused time.** A 30 s `setTimeout` scheduled just before the pause still
  hadn't fired when the workflow finished, right after resume, although 64 s of wall time had
  passed. Node's timers run on the monotonic clock, which stands still while the VM is paused. So a
  timeout means "this much running time", and a wait that should end at a wall-clock time can't be
  a `setTimeout` inside the sandbox. It has to be an engine-side wake-up, like any other external
  event.
- **Pause is much faster than the docs' estimate** of about 4 s per GiB: 113 ms for a 473 MB VM.
  Pause may return before the snapshot is fully written; the restart test shows it was complete
  34 s later.
- **Open stream across a pause: not observed.** The host's `GET /ticks` failed before any data,
  because the sandbox URL used the SDK's default domain (`8080-<id>.e2b.app`), not Embed's. The
  "no open connections across a wait" rule stays a design rule until this is retested with
  Embed's sandbox proxy address.
- **Default template:** Node 20.9.0 and 473 MB RAM. The engine's sandbox template needs its own
  Node version and memory size.

Idle cost: with no sandboxes running, Embed in the `windows/` container used about 0.25 of a core
steadily (ClickHouse at about 22%, with 620 MB RAM) and peaked around 1.1 cores when the services'
healthchecks fire together. That is Embed's own cost, not the POC's; stop the container when it
isn't needed.

Not done: the E2B cloud comparison, the snapshot size, NixOS on WSL, and a longer pause (hours or
days).
