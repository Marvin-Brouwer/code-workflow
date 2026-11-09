# Plan: MVP build

Status: in progress. Package 1, [`@mesh-flow/sandbox`](../../packages/sandbox/README.md), is built
and its conformance suite runs on real backends in CI. Package 2,
[`@mesh-flow/engine`](../../packages/engine/README.md), is built. Package 3,
[`@mesh-flow/core`](../../packages/core/README.md), is built. Covers roadmap step 2 of [`../design.md`](../design.md#roadmap):
a minimal GitHub issue workflow and then the `example` workflow end to end from a CLI, with
sequential repositories, one sandbox per run, `loop` with exits and `limit` on Pi Durable, `input`,
and a gateway for model providers.

## Before it starts

Two things are still open. Neither blocks the first package:

- **E2B rerun:** the day-long pause plus host reboot, and the open-stream check. The outcome only
  changes the E2B backend's notes and tests, not the sandbox interface.
- **Gateway:** decided in [gateway-tool-calls.md](gateway-tool-calls.md). Credentialed tools run
  on the host over a per-loop endpoint. It doesn't change the authoring vocabulary, but `core`
  registers each loop's tools, the engine serves the endpoints, and the sandbox runs agent shell
  commands as a separate user. Model calls over the channel are still a proposal there.

## Build order

Each package is a separate PR, in this order. The order follows dependencies and puts the
packages that don't depend on the open decisions first.

| # | Package | What | Depends on |
|---|---|---|---|
| 1 | `@mesh-flow/sandbox` | the backend interface, E2B, microsandbox and gVisor, backend selection, conformance tests | nothing |
| 2 | `@mesh-flow/engine` | runs, sandbox lifecycle, shutdown and reconciliation, input requests, the CLI | 1 |
| 3 | `@mesh-flow/core` | the authoring vocabulary as a runtime: `workflow`, `loop`, exits, `limit`, `input`, events | Pi Durable |
| 4 | triggers | workflow parameters, the entry file (`defineWorkflows`, `userTrigger`, `webhook`, `schedule`), describe mode; webhook ingress and the scheduler in the engine | 2 and 3 |
| 5 | `@mesh-flow/gateway` | the host side of tool calls (per-loop endpoints, tokens) and model providers (model-first resolution) | 1 to 4 |
| 6 | `@mesh-flow/connector-github` and `examples/github-issue` | GitHub issues, pull requests, comments and checks, its webhook schemas; the smallest workflow that runs end to end | 1 to 5 |
| 7 | the other connectors and `example` | `connector-atlassian`, `connector-gitlab`, `toolchain-dotnet`, `preset-development` made real enough for `develop` | 1 to 5, and 6 for the shared review-watching shape |

### 1. `@mesh-flow/sandbox`

The engine's view of a sandbox, behind one interface ([design section 3](../design.md#3-architecture)).
The POCs already hold working code for all three backends; this turns it into a library.

- **Interface:** create a sandbox from an image with memory and CPU limits and an egress policy;
  exec, read and write files; pause to disk; resume; destroy; list the sandboxes the backend holds
  on this machine (for reconciliation); close the backend. Every method takes a required
  `AbortSignal`.
- **Backends,** one folder each: `e2b` (hosted, E2B Cloud), `microsandbox` (local with a
  hypervisor), `gvisor` (local Linux without one, `runsc` as root).
- **Selection:** hosted configuration picks E2B. Locally, microsandbox when a hypervisor is usable
  (`/dev/kvm` on Linux and WSL, Hypervisor.framework, the Windows Hypervisor Platform), otherwise
  gVisor on Linux, otherwise an error that says why. Host config can force one. The rule is the one
  in [`pocs/sandbox-pause`](../../pocs/sandbox-pause/README.md).
- **Paused state** records which backend made it; resuming on another backend is an error, not an
  attempt ([design section 3](../design.md#3-architecture)).
- **Conformance tests:** the checks from [`pocs/pause-harness`](../../pocs/pause-harness/README.md)
  (memory, processes and the stack survive a pause; egress is limited to the allowlist) become one
  test suite that runs against every backend. Each backend runs it where it can: gVisor in CI,
  microsandbox and E2B on a machine with a hypervisor or with an E2B key.
- **Known gaps** carried over as open questions, not built around: microsandbox egress to the
  gateway by IP rule (open question 11), native Windows (open question 12).

### 2. `@mesh-flow/engine`

The host process. It never runs workflow code ([design section 3](../design.md#3-architecture)).

- **Runs:** a run record per run (workflow, code version, sandbox, pending input requests keyed by
  request id, status), stored on disk with atomic writes.
- **Lifecycle:** create a sandbox per run, start the workflow runtime in it, relay input requests
  and answers over the `WorkflowRuntime` seam. In the MVP a waiting run keeps its sandbox running;
  pausing on wait is roadmap step 3.
- **The seam** is a mailbox in the sandbox, built on `exec` and `writeFile` only: the runtime
  appends messages (events, input and wake requests, the outcome) to an outbox, the engine
  long-polls it with a short shell loop and writes answers to an inbox. The engine makes every
  call, so nothing in the sandbox reaches the host, and it aborts its poll before a pause.
  Wake requests are the engine-side timed waits. The messages and the runtime's side of the
  mailbox are their own package, [`@mesh-flow/protocol`](../../packages/protocol/README.md), so
  `core` doesn't depend on the engine.
- **Shutdown** ([design section 5](../design.md#5-durability)): on `SIGINT`, `SIGTERM`, an uncaught
  error or a normal exit, abort the root signal, pause every running sandbox to disk within a
  deadline, flush the run records, close every backend process the engine started, then exit. A
  second signal skips the pauses; the next start reconciles. `process.on('exit')` runs
  synchronously, so all of this happens before it.
- **Reconciliation** on every start: remove sandboxes the engine has no record of, mark runs whose
  sandbox is gone for restart, resume nothing automatically.
- **CLI:** `serve` (the engine, in the foreground, one per machine and user), and clients that
  talk to it over a local socket: `run <workflow>`, `answer <run> <request> <value>`, `list`,
  `show`, `events`, `stop`, `resume` and `restart <run>`.

### 3. `@mesh-flow/core`

Implements the authoring vocabulary (now `packages/core/src/_module/core.mts`), running inside the
sandbox.

- `loop`'s result types come from [`pocs/loop-typing/src/core.mts`](../../pocs/loop-typing/src/core.mts)
  (proven in the typing POC).
- Exits as in [design section 4](../design.md#exit-tools-gates-on-may-this-agent-finish), plus
  `limit({ turns?, minutes? })` ([Loop limits](../design.md#loop-limits)): `minutes` counts agent
  runtime only and excludes human waits.
- Errors bail by default ([design section 6](../design.md#6-failure-and-cancellation)); exit-schema
  errors and `verify` findings go back to the agent.
- No compaction: hitting the context limit rejects the loop ([Context](../design.md#context)).
- The event tree (`id`, `parentId` via `AsyncLocalStorage`) from the start, since the CLI shows it
  too.
- Pi Durable sessions keyed by call site and name.

### 4. Triggers

[Design section 4, Triggers](../design.md#triggers). Built before the gateway because it changes
`workflow` and how the engine starts a run, both just built, and so the GitHub example starts in
its final shape. It doesn't change what the gateway builds on: tools, per-loop endpoints and
credentials stay as they are.

- **Core:** `workflow(name, parameters, body)` with the body getting `{ parameters, abortSignal }`
  (also for workflows without parameters); `defineWorkflows`, `userTrigger`, `webhook`,
  `schedule`, with the type checks between a trigger and its workflow as type tests; describe mode,
  and starting one named workflow from the entry file.
- **Engine:** read and cache the describe output per commit; `mesh-flow run <name>` starts that
  workflow from `workflows/main.mts`; generic webhook ingress (the built-in signature schemes,
  JSON Schema check, 4xx, delivery id as run key), tested with plain zod schemas and no connector; the scheduler on the wall clock, with the overlap rule; `mesh-flow triggers`
  lists what the entry file declares. Webhook secrets come from the local credential store; until
  the gateway's store exists (step 5), a webhook secret is set with the CLI and kept in the engine's
  home directory, never in the workflow repository.
- **Docs:** the core README (the file no longer starts itself) and the engine README (`run <name>`
  goes through the entry file), and `examples/example` gets an entry file.
- **Tests:** a redelivered webhook reuses its run; a payload that doesn't fit gets a 4xx and no
  sandbox; a payload a `.refine` rejects ends the run as not for this workflow; an overlapping
  schedule tick is skipped; shutdown completes while a webhook request or a describe run never
  settles.

### 5. `@mesh-flow/gateway`

The host side of tool calls ([gateway-tool-calls.md](gateway-tool-calls.md)): per-loop and
run-level endpoints with tokens over the host↔sandbox channel, host-side input validation,
revocation when a loop settles. Model providers on their native API
([design section 7](../design.md#model-providers)), model-first resolution over the user's ordered
providers, usage per run. Providers and credentials come from a local credential store, never from
`.env`. The triggers' webhook secrets move into the same store. AWS, git and CodeArtifact are
roadmap step 5.

### 6. `@mesh-flow/connector-github` and `examples/github-issue`

A GitHub connector with the same shape as the GitLab one: functions for code, tools for agents,
checks for `verify`.

- **Issues:** collect an issue (it renders as the path of its Markdown dump, like a Jira story),
  comment on it, label or close it.
- **Repositories and pull requests:** checkout, push, open a pull request (idempotent: reuse the
  branch and an open pull request), reply to review comments, `checksPass(pullRequest)` as a check.
- **Review watching:** `github.review(pullRequest, handlers)` like `gitlab.review`, on the engine's
  durable external-event primitive (open question 7 applies to both). In the MVP the run stays up
  while it waits.
- **Credentials** never in the sandbox: API calls and pushes are host-side tools; how fetching
  gets its credential is decided here (see [gateway-tool-calls.md](gateway-tool-calls.md)).
- **Webhook shortcuts:** `github.issueLabeled(label)` and the review events as schemas with
  GitHub's signature scheme filled in, for `webhook` triggers and for review watching, and
  `github.onIssueLabeled(workflow, label)` as a ready-made trigger. `connector-gitlab` gets the
  same for merge requests in step 7.

`examples/github-issue` is deliberately tiny: one issue, one repository, no separate QA or code
review, no dependency order. Pick up the issue, fix it, open a pull request, handle review comments
until it's merged. It starts from a button or from labelling an issue `ai-fix`:

```ts
// workflows/main.mts
export default defineWorkflows(
	userTrigger(fixIssue),
	github.onIssueLabeled(fixIssue, 'ai-fix'),
)

// workflows/fix-issue.mts
export const fixIssue = workflow('fix-issue', { issue: github.issueNumber }, async ({ parameters }) => {
    const issue = await github.collect(parameters.issue);
    const repository = await github.checkout(issue.repository, { branch: `fix/${issue.number}` });

    await developer.loop`
        Fix ${issue} in ${repository}. Push with ${github.push(repository)}, then ${succeed()}.
        ${limit({ minutes: 30 })}
    `;

    const pullRequest = await github.openPullRequest(repository, {
        title: issue.title,
        description: `Fixes #${issue.number}`,
    });

    await github.review(pullRequest, {
        comments: (comments) => developer.loop`
            Handle these review comments on ${pullRequest.url}: ${comments}.
            Change the code where a comment asks for it, push with ${github.push(repository)},
            and reply to every comment with ${github.reply(pullRequest)}.
            When every comment is handled, ${succeed()}.
        `,
    });
});
```

It runs before `develop` because it needs only one connector and no toolchain package, so it is
the first proof that the sandbox, engine, core and gateway work together.

### 7. The other connectors and `example`

The sketches in `packages/` and `examples/example/` made real enough to run `develop` end to end
against one repository at a time. `inDependencyOrder` runs sequentially until roadmap step 4.

## Rules for every package

- **Name and shape.** `@mesh-flow/<name>` under `packages/`. These are publishable libraries, not
  POCs: one concept per file, grouped in folders by concept, no comment section boundaries.
  Each public entry point is a file in `src/_module`, named after its subpath (the package's own
  name for `.`), and holds only exports; connectors and toolchains export their namespace
  (`export * as jira from '../jira.mts'`). tsdown builds `src/_module/*.mts`, and `exports` in
  `package.json` lists each with its `source`, as in rooted.
- **TypeScript and lint.** `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`). `pnpm lint` (oxlint, type-aware) and `pnpm typecheck` pass before
  a PR goes up.
- **Abort signals.** Every async function, connector, tool and primitive takes a required
  `AbortSignal`, and aborting it settles the work promptly. A package isn't done without a test
  showing shutdown completes while some work never settles.
- **Shutdown.** Anything that starts a process, a server or a sandbox closes it on shutdown and is
  found and cleaned up on the next start when it couldn't. A test kills the engine with `SIGKILL`
  mid-run, starts it again and checks that no sandbox or backend process is left behind.
- **Idempotent creates.** Primitives that create things reuse what's already there.
- **No credentials in the sandbox,** and no `.env` files for user settings.
- **Tests** live next to the package (`test/`) and run on [vitest](https://vitest.dev):
  `*.test.mts` for unit tests, `*.spec.mts` for functional ones, each body as arrange, act, assert.
  Tests that need something real on the machine (a sandbox backend, a service) are opt-in by
  environment variable, so `pnpm test` runs anywhere.
- **Build.** [tsdown](https://tsdown.dev) (on rolldown) to ESM with declarations, one entry per
  file in `src/_module`.
- **No JavaScript files.** Sources, tests and fixtures are TypeScript, also code that runs inside a
  sandbox: tests transpile it before they copy it in.
- **README.** Every package has a `README.md`: what it's for, who uses it, and code samples for
  the average use. It's what npm shows, so it stands on its own without the design docs.

## Done when

First, `examples/github-issue` runs from the CLI against a real issue in a test repository: a fix,
a pull request, and a review comment answered with a change.

Then `example`'s `develop` runs from the CLI against one story and one repository: research, a plan
approved through `answer`, implementation with `verify`, a merge request. Stopping the engine with
`Ctrl+C` mid-run leaves no sandbox or backend process running, and starting it again reports the
run as restartable.
