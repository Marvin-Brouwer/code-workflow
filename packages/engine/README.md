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

### Build and deploy an app

An app is a package whose `main` in `package.json` is its entry file, which exports `defineMeshFlow` (see [`@mesh-flow/core`](../core/README.md#apps)). The engine doesn't take the source: it takes the built app, bundled with its dependencies, so the sandbox has nothing to set up and only runs `node`.

```bash
mesh-flow build    # bundles the entry file into .mesh-flow/app, with mesh-flow.json saying what it declares
mesh-flow deploy   # hands .mesh-flow/app to the engine on this machine as the app's new current version
mesh-flow dev      # builds and deploys again on every change (not in node_modules), so the triggers are live while you work
```

`build` is [`@mesh-flow/build`](../build/README.md): in CI, build the app there and deploy what it wrote. The app's name is the `name` in `package.json` without its scope (`--app` to give another). Deploying goes over the engine's local socket; deploying to an engine on another machine needs authentication, which is still to come.

The engine keeps every version it was given, named by the first 12 characters of the tarball's SHA-256, so the same build deploys as the same version. Deploying makes a version the current one; webhooks and schedules follow it at once. A run copies its version's tarball next to its record, so `restart` runs the code it first ran, also after a new deploy or `mesh-flow app remove`.

```bash
mesh-flow app list               # example  3f2a9c0d1e7b  built 2026-11-09T10:00:00.000Z
mesh-flow triggers               # the current version's sandbox, workflows, their parameters and triggers
mesh-flow app remove example     # its webhooks and schedules stop; its runs stay
```

The sandbox image needs `node` and what the engine uses in it: `sh`, `cat`, `kill`, `mkdir`, `chmod`, `rm`, `mv`, `tail`, `wc`, `sleep`, `base64` and `tar`, plus `setsid` on E2B and microsandbox. Debian-based images such as `node:22-slim` have all of them.

### Start a run and answer it

The other commands talk to the running engine. Every run starts through one of the triggers the app's current version lists, and `trigger` always takes the parameters:

```bash
mesh-flow trigger user develop -p '{"key":"ABC-123"}'   # as the button would
mesh-flow trigger webhook fix-issue -p @delivery.json   # as a delivery would, without the signature check
mesh-flow trigger schedule 'report daily' -p '{}'       # the schedule now, with these parameters instead of its own
mesh-flow list                                          # run-3f2a9c0d1e7b  develop  running  needs input: story
mesh-flow show run-3f2a9c0d1e7b                         # the question, the fields, and how to answer
mesh-flow answer run-3f2a9c0d1e7b story '{"key":"ABC-123"}'
mesh-flow events run-3f2a9c0d1e7b
```

A webhook payload given to `trigger` still goes through the trigger's schema in the sandbox, so a payload it turns down ends the run as `skipped`.

After a restart of the engine, a run that was paused stays paused until you resume it, and a run whose sandbox is gone can be restarted:

```bash
mesh-flow resume run-3f2a9c0d1e7b   # carries on where it was, same process, same pending requests
mesh-flow restart run-3f2a9c0d1e7b  # from the top, in a new sandbox, with the code it first ran
mesh-flow stop run-3f2a9c0d1e7b     # removes its sandbox; branches and merge requests stay
```

### Triggers

An app's entry file lists what can start its workflows: buttons, webhooks and schedules (see [`@mesh-flow/core`](../core/README.md#triggers)). `mesh-flow build` writes down what it declares, so the engine never runs the entry file to learn it, and an unrelated webhook delivery never costs a sandbox.

#### Webhooks

`serve --webhook-port 8787` takes deliveries over plain HTTP on `127.0.0.1` (`--webhook-host` to change that), at `POST /webhooks/<app>/<webhook>`. Put a tunnel or a reverse proxy with TLS in front of it to reach it from outside. Each webhook needs a secret, which only the gateway's credential store holds, never the app:

```bash
mesh-flow webhook secret example fix-issue --generate   # prints a new secret to paste into the sender
printf '%s' "$SECRET" | mesh-flow webhook secret example fix-issue
```

Everything is checked on the host, before a sandbox is made:

| Check, in this order | Answer when it fails |
|---|---|
| a secret is set for the app's webhook | 404 |
| the app is deployed, and its current version has the webhook | 404 |
| the delivery is signed with the secret (a secret header, or an HMAC-SHA256 of the body) | 401 |
| the body is JSON, up to 25 MB | 400, 413 |
| the payload fits the input side of the trigger's schema, as JSON Schema | 422, with the problems |

A delivery that passes gets `202` and a new run on the current version. Its delivery header (such as `x-github-delivery`), or a hash of the body without one, is the run's key: a redelivery gets `200` and the run it started before. In the sandbox, the schema's `.refine` and `.transform` turn the payload into the workflow's parameters; a delivery they turn down ends the run as `skipped`, which isn't a failure.

#### Schedules

The engine follows the schedules of every deployed app's current version, and starts each run on its own clock. A deploy or a removal re-arms them at once. A tick is skipped while the previous run of the same schedule is still going, also when it is paused or waits for a human. A run that is `restartable` doesn't hold its schedule up: it needs a person, and the next tick starts a new run. Ticks missed while the engine wasn't running, or while the machine slept, aren't made up for.

### Model providers and credentials

Agents name a model id; the engine's gateway ([`@mesh-flow/gateway`](../gateway/README.md)) resolves it to the first provider in your list that offers it, and sends the model calls with that provider's key. Keys and secrets are sealed in the engine's home, in `gateway/credentials.json`, with a key in the OS keychain or, where there is none, `gateway/store.key`. `--no-keychain` keeps it in the file. Nothing of it is in the app, in a `.env` file or in the sandbox.

```bash
mesh-flow provider kinds                                    # the kinds of provider the gateway can call
mesh-flow provider add anthropic --kind anthropic < anthropic-key.txt
mesh-flow provider add router --kind openrouter < openrouter-key.txt
mesh-flow provider order router anthropic                   # model first: router is asked first
mesh-flow provider list
mesh-flow credential set github/token < token.txt          # for connectors' host tools
```

These work on the home's files, so they work without a running engine, and a running one sees a change at once. `mesh-flow show <run>` lists what a finished run's model calls used, per model, with the cost from pi-ai's prices.

### Embed the engine

```ts
import { Engine, openAppStore, openRunStore } from '@mesh-flow/engine'
import { openGateway, openGatewayHome } from '@mesh-flow/gateway'
import { microsandboxBackend } from '@mesh-flow/sandbox/microsandbox'

const abortSignal = AbortSignal.timeout(60_000)
const store = openRunStore('/var/lib/my-app/mesh-flow/runs')
const apps = await openAppStore('/var/lib/my-app/mesh-flow/apps', abortSignal)
await apps.deploy('example', '/builds/example.tgz', abortSignal) // a tarball of what `mesh-flow build` wrote
const gatewayHome = await openGatewayHome('/var/lib/my-app/mesh-flow/gateway', abortSignal)
const gateway = openGateway({ home: gatewayHome.directory, credentials: gatewayHome.credentials, providers: gatewayHome.providers })
const engine = await Engine.open({ backend: microsandboxBackend(), store, apps, gateway, log: console.error }, abortSignal)

const run = await engine.startRun({ app: 'example', trigger: { kind: 'user', id: 'develop' }, input: { key: 'ABC-123' }, abortSignal })
// ... later, when the run waits for input:
await engine.answer(run.id, 'story', { key: 'ABC-123' }, abortSignal)

await engine.close({ pause: AbortSignal.timeout(30_000), backend: AbortSignal.timeout(60_000) })
```

`Engine.open` reconciles before it returns. `close` is what `serve` calls on Ctrl+C. `serveEngine` and `handleShutdown` are the rest of `serve`, for a process of your own: `serveEngine` also runs the scheduler and, with `webhooks: { port }`, the webhook ingress.

## How it works

### The mailbox

The engine and the runtime share a mailbox directory in the sandbox, `/var/lib/mesh-flow/mailbox`. Before it starts the runtime, the engine writes `start.json`: the workflow to run, the trigger that started it, and its input. (`mesh-flow build` uses the same mailbox, on the host, to have the entry file describe itself.) The runtime appends one JSON message per line to `outbox.jsonl`. The engine writes each answer to `inbox/<request id>.json`. The runtime's pid and log sit next to them.

The messages are in [`@mesh-flow/protocol`](../protocol/README.md#messages): events the engine keeps, `input` and `wake` requests, what an entry file declares, and how the run ended.

The engine makes every call. To read the outbox it runs a short POSIX shell loop in the sandbox (no script to copy in) that returns as soon as there are new lines, or after 20 seconds without any. To answer, it writes a file. So:

- **Nothing in the sandbox has to reach the host**, and the channel is the same on all three backends: it's only `exec` and `writeFile`.
- **No connection stays open across a wait.** Before it pauses a sandbox, the engine aborts its poll and ends any poll loop still running inside, because gVisor can't restore a checkpoint that holds a process an exec started. A pause breaks open connections ([design section 5](../../docs/design.md#5-durability)).
- **Timed waits are kept by the engine.** A `wake` request is answered by the engine's own clock, because timers inside a sandbox disagree across a pause.
- **A runtime that dies says so.** When its process is gone (or a zombie) and the outbox has nothing new, the run fails with the end of its log.

### Gateway calls

Calls that need a credential go through the same mailbox: the runtime appends a `call` message with its endpoint and a token, and the engine writes the answer to the inbox ([protocol: Calls](../protocol/README.md#calls)). Before the runtime starts, the engine opens the run's endpoint on the gateway, for the host tools the app's build lists, and writes its tokens to `gateway.json`, which the runtime removes once it has read it.

- **A call is taken before the engine saves that it read it.** The gateway spends the token and keeps the call as in flight on disk first. A call that was taken but not answered when the engine stopped is answered as interrupted when the run is resumed, with its next token: whether it took effect is unknown, so it isn't run again.
- **A `cancel` message stops a call.** It is still answered, so the runtime gets its next token.
- **A token that comes again fails the run.** Someone else has the run's tokens; the gateway closes every endpoint of the run.
- **When a run ends**, its endpoints are closed and what its model calls used goes into its record.

### Runs

A run record holds the workflow, the trigger that started it and its key, its app version (name, version, entry file and sandbox), the sandbox it lives in, the paused state, how far the engine has read the outbox, and the open requests. Each run has its own directory under the engine's home, with `run.json` (written atomically), `events.jsonl`, `app.tgz` and `start.json`.

| Status | Meaning |
|---|---|
| `starting` | the sandbox is being made and the app unpacked in it |
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

The CLI talks to the engine over HTTP on a Unix socket in the home directory, or a named pipe on Windows. On Linux and macOS only the user who owns the directory can reach the socket. A named pipe on Windows isn't limited to one user yet (see Known gaps). `controlApi(engine, apps)` is a [Hono](https://hono.dev) app with `GET /runs`, `POST /runs`, `GET /runs/:run`, `GET /runs/:run/events`, `POST /runs/:run/answers/:request`, `POST /runs/:run/stop`, `/resume` and `/restart`, `GET /apps`, and `PUT` and `DELETE` on `/apps/:name`. `controlClient(socketPath)` returns the functions that call it.

## Tests

```bash
pnpm --filter @mesh-flow/engine test
```

Unit tests (`*.test.mts`) run anywhere. The functional tests (`*.spec.mts`) run real runs on a stand-in backend that runs each "sandbox" as processes on the host, and pauses them with `SIGSTOP`. They cover deploying apps, a run from start to end, input and wake requests, gateway calls (token rotation, a reused token, a cancel, a host tool that never settles across a shutdown and resume), webhook deliveries (signatures, payload checks, redeliveries, skips), schedules and their overlap rule, a schedule fired by hand, crashes, stop, restart on the version a run first ran, a pause and resume across an engine restart, an engine process killed with `SIGKILL` and cleaned up on the next start, and `SIGINT` in a real process. They need Linux. `close` is also tested against a backend whose create, unpack, poll and pause never settle. The scheduler runs on fake timers in a unit test.

One run end to end on a real backend, across a shutdown and a restart of the engine, runs only when asked:

```bash
MESH_FLOW_ENGINE_TESTS=gvisor RUNSC="sudo $(command -v runsc)" pnpm --filter @mesh-flow/engine exec vitest run test/real-backend.spec.mts
MESH_FLOW_ENGINE_TESTS=microsandbox pnpm --filter @mesh-flow/engine exec vitest run test/real-backend.spec.mts
```

CI runs it on gVisor and microsandbox on Linux, and microsandbox on Windows ([`engine.yml`](../../.github/workflows/engine.yml)).

## Known gaps

- **The named pipe on Windows** has the default security of a pipe, and its name comes from the home path. Another user on the same machine could reach it, or take the name first. Unix sockets are limited to the home directory's owner.
- **E2B** needs its templates in host config, which isn't there yet. `serve` refuses it until then; its API key will come from the gateway's credential store. `Engine` itself takes any backend.
- **Pausing on wait** is roadmap step 3. A waiting run keeps its sandbox running until the engine shuts down.
- **External events** that wake a waiting run (merge request activity) and their durable wait aren't here yet. They will come through the same ingress and signature check as webhook triggers, and fit the same shape as `wake`: a request the engine answers.
- **Turning a trigger on or off** is deploying a version without it, or removing the app, until there is a UI. Webhook secrets an engine kept in `secrets/webhooks.json` before the gateway move into its credential store on the next start.
- **Deploying is local.** `deploy` and `dev` go over the engine's socket on the same machine. Deploying from CI to an engine elsewhere needs authentication, which is still to come.
- **Old versions stay** in the engine's home until their app is removed. There is no clean-up of versions no run uses yet.
- **Webhook payload schemas** are compiled with [Ajv](https://ajv.js.org). A pattern in a schema runs on the host, so a slow regular expression slows the ingress down.
- **Gateway calls go through the mailbox**, so each one waits on a poll on both sides, up to a quarter of a second each way, and a model response comes back whole instead of streamed. That is little next to a model call. A channel of their own, low latency and both ways ([gateway-tool-calls.md](../../docs/plans/gateway-tool-calls.md)), can replace it behind the same `call` messages.
- **Host tools of connectors** are given to `serveEngine` as `tools`; `serve` has none yet. Which connector packages an engine loads them from is decided with the first connector.
- **The agent's shell as a separate user.** The mailbox is `chmod 700` for the runtime's user. That only keeps an agent out once agent shell commands run as another user ([gateway rule 5](../../docs/plans/gateway-tool-calls.md#rules)).
- **Events arrive at least once.** When the engine dies after keeping events but before saving how far it read, it reads those events again after a resume.
- **Answers aren't checked on the host.** The runtime validates an answer against its fields and asks again when it doesn't fit.
