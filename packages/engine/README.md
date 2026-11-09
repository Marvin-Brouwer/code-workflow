# `@mesh-flow/engine`

The mesh-flow host process. It runs every workflow run in a sandbox of its own, passes input requests and their answers between the run and a human, pauses everything when it shuts down, and cleans up after a crash the next time it starts. It never runs workflow code itself ([design section 3](../../docs/design.md#3-architecture)).

It comes with the `mesh-flow` command. The CLI is how you use it day to day. The `Engine` class is for embedding it. What it and the runtime in the sandbox say to each other is in [`@mesh-flow/protocol`](../protocol/README.md).

## Usage

### Run the engine

There is one engine per machine and user. It runs in the foreground:

```bash
mesh-flow serve
```

It picks the sandbox backend for the machine ([`chooseBackend`](../sandbox/README.md#pick-a-backend)): microsandbox when there's a hypervisor, gVisor on Linux without one. `--backend gvisor` forces one, and `--runsc 'sudo /usr/bin/runsc'` says how to call runsc when the engine isn't root. Its records, socket and backend state live in the user's data directory (`~/.local/share/mesh-flow` on Linux). `--home` points it somewhere else.

Ctrl+C shuts it down without leaving anything running. It pauses every running sandbox to disk, saves the run records and closes the backend. A second Ctrl+C skips the pauses that haven't finished, and those runs can be restarted later. A third exits right away.

### Start a run and answer it

The other commands talk to the running engine. From a workflow repository:

```bash
mesh-flow run develop -p '{"key":"ABC-123"}'  # runs develop through workflows/main.mts
mesh-flow list                                # run-3f2a9c0d1e7b  develop  running  needs input: story
mesh-flow show run-3f2a9c0d1e7b               # the question, the fields, and how to answer
mesh-flow answer run-3f2a9c0d1e7b story '{"key":"ABC-123"}'
mesh-flow events run-3f2a9c0d1e7b
```

After a restart of the engine, a run that was paused stays paused until you resume it, and a run whose sandbox is gone can be restarted:

```bash
mesh-flow resume run-3f2a9c0d1e7b   # carries on where it was, same process, same pending requests
mesh-flow restart run-3f2a9c0d1e7b  # from the top, in a new sandbox, with the code it first ran
mesh-flow stop run-3f2a9c0d1e7b     # removes its sandbox; branches and merge requests stay
```

### Triggers

A repository's entry file, `workflows/main.mts`, lists what can start its workflows: buttons, webhooks and schedules (see [`@mesh-flow/core`](../core/README.md#triggers)). The engine never runs it on the host. It runs it once per version of the source in a sandbox, in describe mode, and keeps what it declares in its home, by a hash of the repository's git files as they are on disk. An entry file that can't be described fails once per version of the source too, not on every ask.

`serve` describes every registered repository in the background: when it starts, when a repository is added, and every minute after (`repositoryRefreshMs` in `serveEngine`). Webhooks and schedules go by the last description, so after a change to the entry file they may follow the old one for up to a minute. A run always packs the source as it is when it starts, and fails if its trigger is gone from it. A repository that can't be described keeps its last description, and the problem is logged once.

```bash
mesh-flow triggers                       # the workflows, their parameters and the triggers
mesh-flow repository add --name team     # serve this repository's webhooks and schedules
mesh-flow repository list
mesh-flow repository remove team
```

`run` works for any repository and any workflow its entry file's modules define. Webhooks and schedules only run for registered repositories.

#### Webhooks

`serve --webhook-port 8787` takes deliveries over plain HTTP on `127.0.0.1` (`--webhook-host` to change that), at `POST /webhooks/<repository>/<webhook>`. Put a tunnel or a reverse proxy with TLS in front of it to reach it from outside. Each webhook needs a secret, which only the engine's home holds, never the workflow repository:

```bash
mesh-flow webhook secret team fix-issue --generate   # prints a new secret to paste into the sender
printf '%s' "$SECRET" | mesh-flow webhook secret team fix-issue
```

Everything is checked on the host, before a sandbox is made, so an unrelated delivery never costs a run:

| Check, in this order | Answer when it fails |
|---|---|
| a secret is set for the repository's webhook | 404 |
| the repository was described | 503, try again later |
| its entry file has the webhook | 404 |
| the delivery is signed with the secret (a secret header, or an HMAC-SHA256 of the body) | 401 |
| the body is JSON, up to 25 MB | 400, 413 |
| the payload fits the input side of the trigger's schema, as JSON Schema | 422, with the problems |

A delivery that passes gets `202` and a new run. Its delivery header (such as `x-github-delivery`), or a hash of the body without one, is the run's key: a redelivery gets `200` and the run it started before. In the sandbox, the schema's `.refine` and `.transform` turn the payload into the workflow's parameters; a delivery they turn down ends the run as `skipped`, which isn't a failure.

#### Schedules

The engine reads the schedules of every registered repository again every minute, and starts each run on its own clock. A tick is skipped while the previous run of the same schedule is still going, also when it is paused or waits for a human. A run that is `restartable` doesn't hold its schedule up: it needs a person, and the next tick starts a new run. Ticks missed while the engine wasn't running, or while the machine slept, aren't made up for.

### Configure a workflow repository

`mesh-flow.config.json` in the repository says what sandbox its runs get, how to set it up and how to start the runtime. It lives in git, so it holds no secrets:

```json
{
	"sandbox": {
		"image": "node:22-slim",
		"cpus": 2,
		"memoryMb": 4096,
		"egress": { "allow": ["registry.npmjs.org"] }
	},
	"setup": [["npm", "ci"]],
	"start": ["node"],
	"workflows": "workflows"
}
```

`run <name>` uploads the repository's git files, as they are on disk (tracked files, plus untracked ones that aren't ignored), into the sandbox at `/workflow`. It runs `setup` there one command at a time, then starts `start` with the entry file added, here `node workflows/main.mts`, with the workflow's name and its parameters in the mailbox's `start.json`. The run record pins the commit, and says when there were uncommitted changes. The upload and the start file are kept, so `restart` runs the same code with the same parameters.

The image needs what the engine uses in it: `sh`, `cat`, `kill`, `mkdir`, `chmod`, `rm`, `mv`, `tail`, `wc`, `sleep`, `base64` and `tar`, plus `setsid` on E2B and microsandbox. Debian-based images such as `node:22-slim` have all of them.

### Embed the engine

```ts
import { Engine, openRunStore } from '@mesh-flow/engine'
import { microsandboxBackend } from '@mesh-flow/sandbox/microsandbox'

const signal = AbortSignal.timeout(60_000)
const store = openRunStore('/var/lib/my-app/mesh-flow/runs')
const engine = await Engine.open({ backend: microsandboxBackend(), store, log: console.error }, signal)

const run = await engine.startRun({ directory: '/path/to/workflows', workflow: 'develop', input: { key: 'ABC-123' }, abortSignal: signal })
const declared = await engine.describe('/path/to/workflows', signal) // workflows and triggers, from a sandbox
// ... later, when the run waits for input:
await engine.answer(run.id, 'story', { key: 'ABC-123' }, signal)

await engine.close({ pause: AbortSignal.timeout(30_000), backend: AbortSignal.timeout(60_000) })
```

`Engine.open` reconciles before it returns. `close` is what `serve` calls on Ctrl+C. `serveEngine` and `handleShutdown` are the rest of `serve`, for a process of your own: `serveEngine` also runs the scheduler and, with `webhooks: { port }`, the webhook ingress.

## How it works

### The mailbox

The engine and the runtime share a mailbox directory in the sandbox, `/var/lib/mesh-flow/mailbox`. Before it starts the runtime, the engine writes `start.json`: describe the entry file, or run a workflow with its input. The runtime appends one JSON message per line to `outbox.jsonl`. The engine writes each answer to `inbox/<request id>.json`. The runtime's pid and log sit next to them.

The messages are in [`@mesh-flow/protocol`](../protocol/README.md#messages): events the engine keeps, `input` and `wake` requests, what an entry file declares, and how the run ended.

The engine makes every call. To read the outbox it runs a short POSIX shell loop in the sandbox (no script to copy in) that returns as soon as there are new lines, or after 20 seconds without any. To answer, it writes a file. So:

- **Nothing in the sandbox has to reach the host**, and the channel is the same on all three backends: it's only `exec` and `writeFile`.
- **No connection stays open across a wait.** Before it pauses a sandbox, the engine aborts its poll and ends any poll loop still running inside, because gVisor can't restore a checkpoint that holds a process an exec started. A pause breaks open connections ([design section 5](../../docs/design.md#5-durability)).
- **Timed waits are kept by the engine.** A `wake` request is answered by the engine's own clock, because timers inside a sandbox disagree across a pause.
- **A runtime that dies says so.** When its process is gone (or a zombie) and the outbox has nothing new, the run fails with the end of its log.

### Runs

A run record holds the workflow, the trigger that started it and its key, its source, its config, the sandbox, the paused state, how far the engine has read the outbox, and the open requests. Each run has its own directory under the engine's home, with `run.json` (written atomically), `events.jsonl`, `source.tgz` and `start.json`.

| Status | Meaning |
|---|---|
| `starting` | the sandbox is being made, the workflow uploaded and set up |
| `running` | the runtime runs; it may wait on open requests |
| `paused` | the sandbox is paused to disk with the runtime in it; `resume` picks it up |
| `restartable` | the sandbox is gone; `restart` runs it again from the top |
| `succeeded`, `failed`, `stopped` | done; nothing of it runs any more |
| `skipped` | done without doing anything: the webhook delivery isn't for its workflow, as the run's `reason` says |

### Shutdown and reconciliation

On `SIGINT`, `SIGTERM`, `SIGHUP` or an error nothing caught, the engine stops polling, pauses every running sandbox within a deadline, saves the records and closes the backend. Closing removes every sandbox that isn't paused. A run that couldn't be paused, or was still starting, becomes restartable. Each step is bounded, so a backend call that never settles can't keep the process alive.

Every start reconciles first, because a process can also die without warning (`SIGKILL`, power loss):

- A sandbox that no unfinished run owns is removed.
- A paused run whose paused sandbox is still there stays paused.
- Any other run that was in progress becomes restartable. A sandbox that still runs after a crash is removed: nothing can attach to it again.
- Nothing resumes by itself.
- A sandbox that can't be removed doesn't block the start. It's logged, and the next start tries again.

The home's lock comes first: a second engine on the same home refuses to start, so it can't reconcile away the first one's sandboxes. The lock is `engine.lock`, which the engine refreshes every second. A lock left by an engine that died goes stale after five seconds, and the next start takes it over.

### The control API

The CLI talks to the engine over HTTP on a Unix socket in the home directory, or a named pipe on Windows. On Linux and macOS only the user who owns the directory can reach the socket. A named pipe on Windows isn't limited to one user yet (see Known gaps). `controlApi(engine, repositories)` is a [Hono](https://hono.dev) app with `GET /runs`, `POST /runs`, `GET /runs/:run`, `GET /runs/:run/events`, `POST /runs/:run/answers/:request`, `POST /runs/:run/stop`, `/resume` and `/restart`, `POST /describe`, and `GET`, `PUT` and `DELETE` on `/repositories/:name`. `controlClient(socketPath)` returns the functions that call it.

## Tests

```bash
pnpm --filter @mesh-flow/engine test
```

Unit tests (`*.test.mts`) run anywhere. The functional tests (`*.spec.mts`) run real runs on a stand-in backend that runs each "sandbox" as processes on the host, and pauses them with `SIGSTOP`. They cover a run from start to end, input and wake requests, webhook deliveries (signatures, payload checks, redeliveries, skips), schedules and their overlap rule, describing an entry file, crashes and setup failures, stop, restart, a pause and resume across an engine restart, an engine process killed with `SIGKILL` and cleaned up on the next start, and `SIGINT` in a real process. They need Linux. `close` is also tested against a backend whose create, poll and pause never settle, also while describing an entry file never ends. The scheduler runs on fake timers in a unit test.

One run end to end on a real backend, across a shutdown and a restart of the engine, runs only when asked:

```bash
MESH_FLOW_ENGINE_TESTS=gvisor RUNSC="sudo $(command -v runsc)" pnpm --filter @mesh-flow/engine exec vitest run test/real-backend.spec.mts
MESH_FLOW_ENGINE_TESTS=microsandbox pnpm --filter @mesh-flow/engine exec vitest run test/real-backend.spec.mts
```

CI runs it on gVisor and microsandbox on Linux, and microsandbox on Windows ([`engine.yml`](../../.github/workflows/engine.yml)).

## Known gaps

- **The named pipe on Windows** has the default security of a pipe, and its name comes from the home path. Another user on the same machine could reach it, or take the name first. Unix sockets are limited to the home directory's owner.
- **E2B** needs an API key from the credential store, which comes with the gateway. `serve` refuses it until then. `Engine` itself takes any backend.
- **Pausing on wait** is roadmap step 3. A waiting run keeps its sandbox running until the engine shuts down.
- **External events** that wake a waiting run (merge request activity) and their durable wait aren't here yet. They will come through the same ingress and signature check as webhook triggers, and fit the same shape as `wake`: a request the engine answers.
- **Webhook secrets** live in `secrets/webhooks.json` in the engine's home, readable by its owner only, until the gateway's credential store exists. Turning a trigger on or off is registering or removing its repository until there is a UI.
- **Describing costs a sandbox** per version of the source, with its setup steps. While you edit a registered repository, every change is described again on the next minute's refresh.
- **Webhook payload schemas** are compiled with [Ajv](https://ajv.js.org). A pattern in a schema runs on the host, so a slow regular expression slows the ingress down.
- **Tool calls** to the gateway need their own channel, low latency and both ways ([gateway-tool-calls.md](../../docs/plans/gateway-tool-calls.md)). The mailbox is for the runtime's lifecycle, not for that.
- **The agent's shell as a separate user.** The mailbox is `chmod 700` for the runtime's user. That only keeps an agent out once agent shell commands run as another user ([gateway rule 5](../../docs/plans/gateway-tool-calls.md#rules)).
- **Events arrive at least once.** When the engine dies after keeping events but before saving how far it read, it reads those events again after a resume.
- **Answers aren't checked on the host.** The runtime validates an answer against its fields and asks again when it doesn't fit.
- **Setup output** only shows when a step fails, as the end of its stderr.
