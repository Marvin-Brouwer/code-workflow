# POC: E2B pause and resume

Status: in progress, see [pocs/e2b-pause](../../pocs/e2b-pause/README.md). Passes on an Ubuntu WSL distro and in the `windows/` container on Docker Desktop (2026-11-02) and on NixOS on WSL (2026-11-06); Docker Desktop and NixOS need that container as Embed's host. Adopted for hosted (E2B Cloud); locally microsandbox or gVisor instead of Embed, through the same checks ([`pocs/pause-harness`](../../pocs/pause-harness/README.md)). Settles [open question 1](../design.md#open-questions) (blocking).

## Question

Can a self-hosted E2B pause a sandbox with memory and processes intact, so that a pending `await`
in a Node process resolves in the same stack after resume? And can it run on a machine used for
development?

Running it needs `/dev/kvm`, so it runs on a developer machine, not in a cloud CI container.

## Setup

- **Step 0: find out what self-hosting needs.** Check E2B's current self-hosting docs for the
  requirements and whether pause is supported there. Then check `/dev/kvm` on NixOS under WSL2
  with nested virtualization. If that doesn't work, the fallback is a separate Linux box, and the
  README names which one was used.
- **Host script** (`pocs/e2b-pause/src/host.mts`, E2B SDK): creates a sandbox, uploads the stub
  and starts it, waits for it to report "waiting", then pauses, resumes, delivers the answer and
  checks the result.
- **Sandbox stub** (`src/stub.ts`): a fake workflow with a real async stack,
  `workflow → loop → input()`. Before waiting it writes its PID, a random value and the stack to a
  file. It allocates about 500 MB to look like a run with a checkout and toolchain.
- **No open connection across the wait** ([design rule](../design.md#5-durability)). The stub
  watches for an answer file, and the host writes that file only after resume.

## Success (all required)

- After resume, the waiting `await` resolves and the stub finishes, with the same PID, the same
  random value, and its original stack frames in a stack trace.
- While paused, the sandbox uses no CPU or RAM on the host.
- The pause survives a restart of the E2B host service. A pause that only lasts while the service
  is up doesn't count, because waits last days.
- It runs on a machine used for development, and the README records the setup steps.

## Measured and recorded (not pass/fail)

- Pause time, resume time and snapshot size on disk, for the 500 MB stub.
- What a `setTimeout` and `Date.now()` do across a pause, since clock jumps matter for timeouts
  and token expiry.
- What happens to a TCP connection held open across a pause. This tests the "no open
  connections" rule instead of assuming it.

## Should, not blocking

- Sandbox egress can be limited to an allowlist (gateway plus public package sources).
- The same host script works against E2B cloud with only configuration changed. The API key stays
  in local, uncommitted config.

## Failure

The POC fails if self-hosted pause keeps only the filesystem, or if it can't run anywhere used for
development. [`decisions.md`](../decisions.md#sandboxes) then points to Fly Sprites, which is
cloud only. The other option is making "restart from the top" the normal path rather than the
fallback. Both change the design.

## Run

```bash
pnpm poc:e2b-pause   # on the E2B host, with connection settings from local, uncommitted config
```

## Open questions

- [x] E2B host: the NixOS/WSL2 dev machine works (nested virtualization, KVM and nbd all fine),
  through the `windows/` container; no separate Linux box needed.
- [ ] Should the E2B cloud comparison stay a "should", or drop out of this POC?
