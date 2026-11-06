# Plan: MVP build

Status: plan, nothing built yet. Covers roadmap step 2 of [`../design.md`](../design.md#roadmap):
a minimal GitHub issue workflow and then the `example` workflow end to end from a CLI, with
sequential repositories, one sandbox per run,
`loop` with exits and `limit` on Pi Durable, `input`, and a gateway for model providers.

## Before it starts

Two things are still open. Neither blocks the first package:

- **E2B rerun:** the day-long pause plus host reboot, and the open-stream check. The outcome only
  changes the E2B backend's notes and tests, not the sandbox interface.
- **Gateway credential routes:** [gateway-credential-override.md](gateway-credential-override.md)
  is a proposal. It decides how `@mesh-flow/gateway` routes credentials; it doesn't change the
  sandbox, the engine or the authoring vocabulary.

## Build order

Each package is a separate PR, in this order. The order follows dependencies and puts the
packages that don't depend on the open decisions first.

| # | Package | What | Depends on |
|---|---|---|---|
| 1 | `@mesh-flow/sandbox` | the backend interface, E2B, microsandbox and gVisor, backend selection, conformance tests | nothing |
| 2 | `@mesh-flow/engine` | runs, sandbox lifecycle, shutdown and reconciliation, input requests, the CLI | 1 |
| 3 | `@mesh-flow/core` | the authoring vocabulary as a runtime: `workflow`, `loop`, exits, `limit`, `input`, events | Pi Durable |
| 4 | `@mesh-flow/gateway` | model providers only (credential-injecting reverse proxy, model-first resolution) | the gateway decision |
| 5 | `@mesh-flow/connector-github` and `examples/github-issue` | GitHub issues, pull requests, comments and checks; the smallest workflow that runs end to end | 1 to 4 |
| 6 | the other connectors and `example` | `connector-atlassian`, `connector-gitlab`, `toolchain-dotnet`, `preset-development` made real enough for `develop` | 1 to 4, and 5 for the shared review-watching shape |

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
- **Shutdown** ([design section 5](../design.md#5-durability)): on `SIGINT`, `SIGTERM`, an uncaught
  error or a normal exit, abort the root signal, pause every running sandbox to disk within a
  deadline, flush the run records, close every backend process the engine started, then exit. A
  second signal skips the pauses; the next start reconciles. `process.on('exit')` runs
  synchronously, so all of this happens before it.
- **Reconciliation** on every start: remove sandboxes the engine has no record of, mark runs whose
  sandbox is gone for restart, resume nothing automatically.
- **CLI:** `run <workflow>`, `answer <run> <request>`, `list`, `stop <run>`.

### 3. `@mesh-flow/core`

Turns `packages/core/src/*.d.ts` into an implementation that runs inside the sandbox.

- `loop`'s result types come from [`pocs/loop-typing/src/core.ts`](../../pocs/loop-typing/src/core.ts)
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

### 4. `@mesh-flow/gateway`

Model providers only for the MVP ([design section 7](../design.md#model-providers)): a reverse
proxy per provider on its native API, model-first resolution over the user's ordered providers,
the run token as the sandbox's only credential, usage per run. Providers and credentials come from
a local credential store, never from `.env`. How routes set credentials follows the gateway
decision. AWS, git and CodeArtifact are roadmap step 5.

### 5. `@mesh-flow/connector-github` and `examples/github-issue`

A GitHub connector with the same shape as the GitLab one: functions for code, tools for agents,
checks for `verify`.

- **Issues:** collect an issue (it renders as the path of its Markdown dump, like a Jira story),
  comment on it, label or close it.
- **Repositories and pull requests:** checkout, push, open a pull request (idempotent: reuse the
  branch and an open pull request), reply to review comments, `checksPass(pullRequest)` as a check.
- **Review watching:** `github.review(pullRequest, handlers)` like `gitlab.review`, on the engine's
  durable external-event primitive (open question 7 applies to both). In the MVP the run stays up
  while it waits.
- **Credentials** through the gateway like every connector: the API and git over the gateway,
  nothing in the sandbox.

`examples/github-issue` is deliberately tiny: one issue, one repository, no separate QA or code
review, no dependency order. Pick up the issue, fix it, open a pull request, handle review comments
until it's merged:

```ts
export default workflow('fix-issue', async () => {
    const { issue: number } = await input('Which issue should be fixed?', { issue: github.issueNumber });
    const issue = await github.collect(number);
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

### 6. The other connectors and `example`

The sketches in `packages/` and `examples/example/` made real enough to run `develop` end to end
against one repository at a time. `inDependencyOrder` runs sequentially until roadmap step 4.

## Rules for every package

- **Name and shape.** `@mesh-flow/<name>` under `packages/`. These are publishable libraries, not
  POCs: one concept per file, grouped in folders by concept, no comment section boundaries.
  `index.ts` is only the public surface; connectors and toolchains export their namespace
  (`export * as jira from './jira'`).
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
- **Tests** live next to the package (`test/`). The test runner is picked when the first package is
  set up.

## Done when

First, `examples/github-issue` runs from the CLI against a real issue in a test repository: a fix,
a pull request, and a review comment answered with a change.

Then `example`'s `develop` runs from the CLI against one story and one repository: research, a plan
approved through `answer`, implementation with `verify`, a merge request. Stopping the engine with
`Ctrl+C` mid-run leaves no sandbox or backend process running, and starting it again reports the
run as restartable.
