# @pocs/sandbox-pause

**Outcome: ✅** The local backend rule, as the engine will apply it, on top of the shared
[pause checks](../pause-harness/README.md):

| Host | Backend |
|---|---|
| `POC_SANDBOX=microsandbox` or `gvisor` | that one |
| macOS | microsandbox (Hypervisor.framework) |
| Windows | microsandbox (Windows Hypervisor Platform; gVisor has no Windows build) |
| Linux or WSL with a readable and writable `/dev/kvm` | microsandbox |
| Linux without it (cloud containers, CI) | gVisor |

Hosted runs use E2B Cloud instead; see [`docs/design.md`](../../docs/design.md) section 3.

```bash
pnpm poc:sandbox-pause run | pause | resume | egress
```

The first line of the output names the backend and why. The prerequisites are those of the chosen
POC: [microsandbox](../microsandbox-pause/README.md#prerequisites) or
[gVisor](../gvisor-pause/README.md#prerequisites) (`RUNSC='sudo runsc'` when not root). Each backend
keeps its own paused state, so `resume` only finds a pause made with the same backend.

Checked 2026-11-06 in a cloud container without `/dev/kvm`: it picks gVisor ("/dev/kvm isn't usable
(ENOENT)"), and `run` and `egress` pass.
