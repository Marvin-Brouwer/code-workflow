# code-workflow
Deterministic development pipelines

Workflows are plain TypeScript in git that dispatch to AI agents where that makes sense. Start
with [`docs/design.md`](docs/design.md) and [`CLAUDE.md`](CLAUDE.md).

## Validation POCs

| POC | Outcome |
|---|---|
| [`pocs/loop-typing`](pocs/loop-typing/README.md): `loop` infers its result from the exits | ✅ adopted |
| [`pocs/e2b-pause`](pocs/e2b-pause/README.md): self-hosted E2B pause keeps memory | ⏳ passes on Ubuntu WSL and in the Windows Docker Desktop container; NixOS WSL still to run |

```bash
pnpm install
pnpm lint && pnpm typecheck
pnpm poc:loop-typing
```
