# Plans

Two POCs settle open questions 1 and 2 of [`../design.md`](../design.md#open-questions) before
any MVP code gets written. Each one gets a yes/no outcome against criteria fixed in advance,
recorded in its README.

| Plan | Question | Runs where |
|---|---|---|
| [poc-loop-typing.md](poc-loop-typing.md) | Can `loop` infer its result type from the interpolated exits? | anywhere (`tsc` only) |
| [poc-e2b-pause.md](poc-e2b-pause.md) | Does self-hosted E2B pause keep memory and processes? | a machine with `/dev/kvm` |

## POC pattern

The POCs follow the earlier prototype's pattern: a pnpm workspace, one `@pocs/<name>` project
per POC under `pocs/`, a root script `poc:<name>`, and a README per POC with the question, how to
run it, Findings and an outcome line (✅ adopted / ❌ not adopted).

```text
code-workflow/
  CLAUDE.md, docs/design.md, docs/decisions.md   from the starter
  examples/example/, packages/*                  the option C sketches, not workspace members yet
  pocs/
    loop-typing/                                 @pocs/loop-typing
    e2b-pause/                                   @pocs/e2b-pause
  package.json                                   private; poc:* scripts, lint, typecheck
  pnpm-workspace.yaml                            pocs/*, packages/*, examples/*
  tsconfig.base.json                             strict, NodeNext, noUncheckedIndexedAccess, exactOptionalPropertyTypes
  .oxlintrc.json                                 oxlint, type-aware (oxlint-tsgolint)
```

- oxlint runs at the root over every POC. `pnpm lint` and `pnpm typecheck` both have to pass
  before a PR goes up.
- Node 22, pnpm 10.

## Delivery

1. **PR 1: scaffold plus loop typing.** The workspace, ESLint, the docs and sketches from the
   starter, and `pocs/loop-typing` with its findings filled in.
2. **PR 2: E2B pause.** `pocs/e2b-pause` with the host script and stub, step 0 researched,
   Findings left open until it has run on a machine with `/dev/kvm`.
