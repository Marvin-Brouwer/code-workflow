# `@mesh-flow/*`
Deterministic development pipelines

Workflows are plain TypeScript in git that dispatch to AI agents where that makes sense. Start
with [`docs/design.md`](docs/design.md) and [`CLAUDE.md`](CLAUDE.md).

## Validation POCs

| POC | Outcome |
|---|---|
| [`pocs/loop-typing`](pocs/loop-typing/README.md): `loop` infers its result from the exits | ✅ adopted |
| [`pocs/e2b-pause`](pocs/e2b-pause/README.md): self-hosted E2B pause keeps memory | ⏳ passes on Ubuntu WSL, Docker Desktop and NixOS WSL; not adopted yet |
| [`pocs/gvisor-pause`](pocs/gvisor-pause/README.md): gVisor checkpoint/restore keeps memory, without Docker or KVM | ⏳ passes on NixOS WSL (incl. `wsl --shutdown`) and in a Linux container; not adopted yet |
| [`pocs/microsandbox-pause`](pocs/microsandbox-pause/README.md): microsandbox full snapshots keep memory, from an npm package | ⏳ not run yet (needs KVM or WHP) |

```bash
pnpm install
pnpm lint && pnpm typecheck
pnpm poc:loop-typing
```
