# CLAUDE.md

A durable workflow engine for orchestrating AI agents across multi-repo development work:
research → plan → implement → verify → merge request → review handling. Workflows are plain
TypeScript in git, not something clicked together in a UI.

## Read first

- `docs/design.md`: the design, the decisions behind it, and what is still open.
- `code-style.md`: how code is written here, beyond what the formatter and linter enforce.
- `docs/decisions.md`: alternatives that were considered and rejected or superseded, and why.
  Don't propose these again unless something new changes the trade-off; if it does, say what
  changed.
- `examples/example/`: the reference workflow, and `packages/core/src/_module/core.mts`: the whole
  authoring vocabulary.

## Conventions

- TypeScript, strict. Run the linter (`pnpm lint`, oxlint) after every change and fix what it reports.
- Code style: tabs, no semicolons, single quotes, `.mts` source files with relative imports that
  name the `.mts` file. Run `pnpm format` (oxfmt, `.oxfmtrc.json`) after every change;
  `pnpm format:check` is what a PR has to pass. Markdown is not formatted.
- Every package has a `README.md` that says what it's for and shows the average use in code
  samples, written in the same code style.
- **Workflows are plain async TypeScript.** No workflow DSL: no step objects, no `next()`, no
  combinators, no builder chains (`.then()`, `.returns()`, `.view()`). Control flow is `await`,
  `if`, `for`, `Promise.all`, `throw`.
- **Code owns the control flow; agents are calls inside it.** Don't move ordering decisions into
  prompts.
- **An agent's result only comes through exit tools in its template** (`succeed`, `propose`,
  `verify`, `fail`). Never parse an agent's text for a result.
- **A tool is also a function.** Building blocks must work both when called from code and when
  interpolated into a prompt.
- **Packages ship no agents.** Agents (model, reasoning, system prompt) belong to the workflow
  repo; packages take them as parameters and own only task instructions.
- **No credentials in the sandbox.** Not in env vars, files or snapshots. Everything that needs
  a credential goes through the host gateway (proxy, short-lived handout, or credential helper).
- **No `.env` files for user settings.** Providers and credentials are managed in the UI;
  static config in git holds only non-secret team settings.
- **Abort signals are mandatory.** Every async seam, connector, tool and primitive takes a
  required `AbortSignal`, and aborting it settles the work promptly. A deliverable isn't done
  without a test showing shutdown completes when the work never settles.
- **Primitives that create things are idempotent** (reuse an existing branch, merge request,
  comment or status), so a rerun is cheap and safe.
- **No customer or employer names anywhere** (code, docs, examples, test data, commit messages,
  URLs). The reference workflow is called `example`. This repo is public.

## Git

- **Never force push** (no `--force`, `--force-with-lease`, amend or rebase of pushed commits). Fix
  a mistake with a new commit.
- **Commit often, and commit working code:** small commits that each pass `pnpm lint`,
  `pnpm format:check` and the tests they touch.
