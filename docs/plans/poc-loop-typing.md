# POC: `loop` result typing

Status: ✅ done, see [pocs/loop-typing](../../pocs/loop-typing/README.md). Settles [open question 2](../design.md#open-questions).

## Question

Can ``agent.loop`...` `` infer its result type from the exits interpolated in the template, with
no annotation, generic argument or `as const` at the call site?

## Approach

- Types only. The runtime stubs throw, and nothing calls a model.
- `pocs/loop-typing` gets its own copy of `packages/core/src/index.d.ts` to iterate on.
- Type tests (`expect-type`, checked by `tsc --noEmit`) pin every case below.

The current sketch already has two bugs this POC has to fix:

- With no exits, `Extract<…>` is `never`, and `never extends Exit<infer T>` gives `unknown`, not
  `string`.
- With `verify` plus `propose(Plan)`, it gives `void | Plan` instead of `Plan`.

## Cases

| Interpolated exits | Expected result |
|---|---|
| none | `string` |
| `succeed()` | `void` |
| `succeed(Schema)` | `z.infer<Schema>` |
| `succeed(folder)` | `WorkspaceFolder` |
| `propose(Plan)` | `Plan` |
| `verify(...checks)` | `void` |
| `verify(...)` + `propose(Plan)` | `Plan` (verify is a gate, not a result) |
| `verify(...)` + `succeed(Schema)` | `z.infer<Schema>` |
| `propose(Plan)` + `fail` | `Plan` (`fail` adds nothing) |
| `fail` only | `never` |
| `succeed(A)` + `succeed(B)` | `A \| B` (open question below) |
| exits mixed with tools, files, folders, strings, objects | same as without the non-exit values |
| an `any`-typed value interpolated | does not turn the result into `any` |

## Success

- Every case in the table passes as a type test, with no call-site annotations.
- Negative tests with `@ts-expect-error` pass. Examples: using a `Plan` result as `string`, and
  passing a non-exit that happens to have `kind: 'exit'`.
- `examples/example/workflows/develop.mts` and `packages/preset-development` type-check against
  the POC's types. The only allowed edits are import paths; any other change they need is listed
  in the README.
- The editor hover on the result shows the resolved type (`Plan`), not `ResultOf<[…]>`. This is
  checked by hand and written down.
- No "type instantiation is excessively deep" error. A template with 20 interpolated values
  type-checks in under 2 seconds.

## Failure

The POC fails if inference needs anything at the call site: an explicit generic, `as const`, a
wrapper or a builder. `loop(Schema)` and `.returns()` are already rejected in
[`decisions.md`](../decisions.md#authoring-details), so a failure reopens the authoring model.
Failing only the hover criterion is a ⚠️, not a ❌.

## Run

```bash
pnpm poc:loop-typing   # tsc --noEmit over the type tests and the sketches
```

## Open questions

- [x] Two result-bearing exits, such as `succeed(A)` plus `succeed(B)`: union `A | B`, or a
  compile error? The union: it falls out of the design with no extra code.
