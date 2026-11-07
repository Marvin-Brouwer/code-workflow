# `@mesh-flow/*`
Deterministic development pipelines

Workflows are plain TypeScript in git that dispatch to AI agents where that makes sense. Start
with [`docs/design.md`](docs/design.md) and [`CLAUDE.md`](CLAUDE.md).

## Validation POCs

| POC | Outcome |
|---|---|
| [`pocs/loop-typing`](pocs/loop-typing/README.md): `loop` infers its result from the exits | ✅ adopted |
| [`pocs/e2b-pause`](pocs/e2b-pause/README.md): self-hosted E2B pause keeps memory | ✅ adopted for hosted (E2B Cloud); Embed not used locally |
| [`pocs/gvisor-pause`](pocs/gvisor-pause/README.md): gVisor checkpoint/restore keeps memory, without Docker or KVM | ✅ adopted locally without a hypervisor |
| [`pocs/microsandbox-pause`](pocs/microsandbox-pause/README.md): microsandbox full snapshots keep memory, from an npm package | ✅ adopted locally with a hypervisor |
| [`pocs/sandbox-pause`](pocs/sandbox-pause/README.md): picks microsandbox or gVisor by whether a hypervisor is usable | ✅ |

```bash
pnpm install
pnpm format:check && pnpm lint && pnpm typecheck
pnpm poc:loop-typing
```
