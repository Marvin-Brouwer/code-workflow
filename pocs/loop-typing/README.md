# @pocs/loop-typing

**Outcome: ✅ adopted.** ``agent.loop`...` `` infers its result type from the interpolated exits,
with nothing at the call site. Every case in the plan passes, the sketches type-check, an editor's
hover shows the resolved type, and wide templates stay cheap. The fixed types are in
[`src/core.mts`](src/core.mts) and should replace the exit types in
`packages/core/src/index.d.ts`.

Plan and criteria: [docs/plans/poc-loop-typing.md](../../docs/plans/poc-loop-typing.md).

## Run

```bash
pnpm poc:loop-typing
```

That runs four checks, and any failure fails the command:

1. `tsc -p tsconfig.json`: the type tests in [`test/loop-result.mts`](test/loop-result.mts),
   written with `expect-type`.
2. `tsc -p tsconfig.sketches.json`: `examples/example` and the sketch packages, against
   `src/core.mts`, with [`stubs/`](stubs/README.md) for the modules they import that don't exist yet.
3. `scripts/hover.mts`: asks the TypeScript language service, the same call an editor's hover
   makes, what `research` and `plan` in `develop.mts` show.
4. `scripts/timing.mts`: generates one `loop` with 20 interpolated values, and a file with 50 of
   them, and type-checks them against a 2 s budget.

## What changed in the types

The sketch's `Exit<T>` was a plain `{ kind: 'exit'; result?: T }` and
`ResultOf = Extract<Values[number], Exit<unknown>> extends Exit<infer T> ? T : string`. The POC
replaces that with:

- **A brand on exits.** `Exit<T>` and `Gate` carry a `unique symbol` key. Only `succeed`,
  `propose`, `verify` and `fail` make them, so a look-alike object is text, not an exit.
- **`verify` returns a `Gate`, not `Exit<void>`.** A gate decides whether the agent may finish but
  carries no result. That's what makes `verify` + `propose(Plan)` give `Plan`.
- **`ResultOf` in three steps.** No exits gives `string`. Only gates gives `void`. Otherwise it's
  the union of the result-bearing exits' results; `fail` is `Exit<never>` and drops out of the
  union.
- **`any` values are skipped** element by element, so one `any` in a template doesn't make the
  whole result `any`.
- `z.ZodTypeAny` became `z.ZodType`, because the POC uses zod 4.

The `loop` signature itself is unchanged: `loop<Values extends readonly unknown[]>(prompt, ...values: Values)`.
TypeScript already infers a tuple from a tagged template's values, so no `const` modifier is needed.

## Findings

Ran 2026-10-30 with TypeScript 6.0.3 and zod 4.6.7.

| Criterion | Result |
|---|---|
| Every case in the plan's table, no call-site annotations | ✅ 20 type tests pass |
| Negative tests (`@ts-expect-error`) | ✅ 4 pass: Plan as string, string as Plan, look-alike exit, file as schema |
| Sketches type-check, import paths only | ⚠️ one annotation needed, see below |
| Hover shows the resolved type | ✅ `const research: WorkspaceFolder`, `const plan: { path: string; repositories: …; dependencies: … }` |
| No "excessively deep", under 2 s | ✅ no diagnostics; 0.8 to 1.0 s per file, including about 0.95 s for zod and the libs alone |

**The sketch's types fail 11 of these assertions.** Run against the original `ResultOf`:

- no exits gives `unknown`, not `string` (every no-exit case);
- `verify` + `propose(Plan)` and `verify` + `succeed(Plan)` give `never` instead of `Plan`,
  because `infer` over `Exit<void> | Exit<Plan>` can't pick one result;
- an `any` value turns the result into `unknown`;
- a look-alike `{ kind: 'exit', result: 42 }` is taken as an exit and gives `42`.

**One sketch edit, not about `loop`.** `inDependencyOrder` can't infer `Result` from a callback that
both returns it and receives it as `upstream`; TypeScript gives `upstream` the type `unknown[]`.
`develop.mts` now annotates the callback's return type
(`async (part, upstream): Promise<{ packages: string[] }> =>`). That's the only change to the
sketches; not even import paths needed editing, because the stubs and `paths` in
`tsconfig.sketches.json` cover the imports. Options for later, when `inDependencyOrder` is built (design open question 5):
keep the annotation, or have packages export the result type (`Delivered`) so the annotation is
one word.

**Other things the sketches need before they're real packages**, found while wiring them up:

- The sketches import connectors as namespaces (`import { jira } from
  '@mesh-flow/atlassian'`) while each module exported its members directly. Since
  then each package's `index.mts` exports its namespace (`export * as jira from './jira'`).
- The sketches use extensionless relative imports, so they type-check under `bundler` resolution,
  not under the repo's `NodeNext`.
- `Tool` is an opaque `{ name }`, not callable. "A tool is also a function" (`CLAUDE.md`) isn't
  expressed in the types yet. That's outside this POC.

**Decided along the way:** two result-bearing exits (`succeed(A)` + `succeed(B)`) give `A | B`.
That was the plan's open question; the union fell out of the design and needed no extra code.
