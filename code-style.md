# Code style

How code in this repository is written. Formatting is enforced by tooling; the rest is checked in review.

## Formatting

- Tabs, no semicolons, single quotes. `pnpm format` (oxfmt, `.oxfmtrc.json`) applies it, and `pnpm format:check` is what a pull request has to pass. Markdown is not formatted.
- TypeScript, strict. `pnpm lint` (type-aware oxlint, `.oxlintrc.json`) has to pass without warnings. A rule is only disabled on one line, with the reason next to it.
- Sources are `.mts` files, and relative imports name the `.mts` file.
- Imports are sorted: packages first, then `../`, then `./`, alphabetically within each.

## Files

- One concept per file, named after it. No section banner comments to group code inside a file: split it instead.
- A package's public entry points are `src/_module/<name>.mts`.
- Every package has a `README.md` that says what it's for and shows the average use in code samples that stand on their own, in this style.

## Names

- **`abortSignal`, not `signal`**, for an `AbortSignal`: in options, contexts and parameters. Where a platform API names it `signal` (`fetch`, `readFile`, `AbortController`), pass it as `signal: abortSignal`. Older code in protocol and engine still has positional `signal` parameters; rename them when you touch that code.
- Names say what a value is. A unit goes in the name of a number: `timeoutMs`, `budgetMinutes`.
- No magic values: name a number or string that means something, with a doc comment when the name alone doesn't say why.
- One meaning per verb within a file.

## Shape

- Prefer functions, modules and data (types, zod schemas, records) over classes. A class is fine internally when it owns a lifetime, private state or a resource, as long as the interface a user sees reads as functions: factories, functions that take inputs and return values or promises, no inheritance and nothing the caller has to mutate. Error classes are the exception.
- Simple, readable code first. Prefer a mature, well-maintained package over writing our own.
- Every async seam takes a required `AbortSignal`, and aborting it settles the work promptly.

## Docs

- Doc comments on exported members and on anything that isn't obvious: what it does and why, in plain sentences.
- No em dashes.

## Tests

- vitest, in Arrange / Act / Assert form, with the three comments.
- Cleanup through `onTestFinished`, so a failing assertion leaves nothing running.
- A bug fix comes with a test that fails without the fix.
