# `@mesh-flow/protocol`

What the mesh-flow engine on the host and the workflow runtime in a sandbox say to each other. It covers the messages the runtime sends, the requests it waits on, the mailbox they go through, and the runtime's side of that mailbox.

Two packages use it. [`@mesh-flow/engine`](../engine/README.md) reads the mailbox from the host. `@mesh-flow/core` writes it from inside the sandbox. Workflow code never sees it.

## Usage

### The runtime's side

The engine starts the runtime with `MESH_FLOW_MAILBOX` set. `RuntimeMailbox` sends messages and waits for answers:

```ts
import { RuntimeMailbox } from '@mesh-flow/protocol'

const abortSignal = AbortSignal.timeout(24 * 60 * 60_000)
const mailbox = RuntimeMailbox.fromEnvironment()
const start = await mailbox.readStart(abortSignal) // what to do: check it with RunStart
mailbox.send({ type: 'event', event: { id: 'run', type: 'workflow-started', at: new Date().toISOString() } })

mailbox.send({ type: 'request', request: { kind: 'input', id: 'story', question: 'Which story?', fields: { key: { type: 'string' } } } })
const { value } = await mailbox.answer('story', abortSignal)

mailbox.send({ type: 'request', request: { kind: 'wake', id: 'tomorrow', at: '2026-11-08T09:00:00Z' } })
await mailbox.answer('tomorrow', abortSignal)

mailbox.send({ type: 'succeeded' })
```

It uses only Node built-ins and holds no connection, so a pause of the sandbox can't break it. Node runs it straight from TypeScript, with no build step.

### The host's side

The engine checks every line it reads with the schemas:

```ts
import { answerFile, defaultMailboxDirectory, mailboxLayout, RuntimeMessage } from '@mesh-flow/protocol'

const layout = mailboxLayout(defaultMailboxDirectory)
const line = '{"type":"succeeded"}' // a line of layout.outbox
const message = RuntimeMessage.parse(JSON.parse(line))
const answerPath = answerFile(layout, 'story') // where the answer to request `story` goes
```

## Messages

The runtime appends one message per line to `outbox.jsonl`:

| Message | Means |
|---|---|
| `{ type: 'event', event }` | a node of the run's event tree. `id`, `type` and `at` are required, `parentId` is optional, and any other fields pass through as they are |
| `{ type: 'request', request }` | the runtime waits on something only the engine can answer |
| `{ type: 'succeeded' }` | the run is over and it worked |
| `{ type: 'failed', error }` | the run is over and it didn't |
| `{ type: 'skipped', reason }` | the run is over without doing anything: the webhook delivery that started it isn't for its workflow |
| `{ type: 'described', description }` | what the entry file declares, for a `describe` start: its workflows with their parameters as JSON Schema, its triggers, and the host tools it calls |
| `{ type: 'call', id, endpoint, token, call }` | a call to the gateway on the host, answered in the inbox under `id` (see [Calls](#calls)) |
| `{ type: 'cancel', id }` | the runtime stopped waiting for call `id`; the host stops it and still answers |

There are two kinds of request:

| Request | Answered |
|---|---|
| `{ kind: 'input', id, question, fields }` | by a human. `fields` holds JSON Schema per field, and the runtime validates the answer |
| `{ kind: 'wake', id, at }` | by the engine's clock at `at`. Timers inside a sandbox disagree across a pause, so the engine keeps the time |

The engine writes each answer to `inbox/<request id>.json`, as `{ value }`, or `{}` for a wake. Request ids end up as file names, so they are limited to letters, digits, `-` and `_`, up to 64 characters. An answer stays in the inbox, so an id is used once per run attempt: a workflow that waits in a loop gives each wait its own id, such as `poll-ci-3`. `RuntimeMailbox` throws when a request id comes again.

## Calls

Anything that needs a credential runs on the host, in the gateway: host tools, and model requests. The runtime calls it with a `call` message on an endpoint: the run's own, which the engine hands over in `gateway.json`, or one a loop opened for its tools. Every call spends a token, and the answer carries the next one:

```ts
import { CallAnswer, EndpointGrant, RuntimeMailbox } from '@mesh-flow/protocol'

const abortSignal = AbortSignal.timeout(60_000)
const mailbox = RuntimeMailbox.fromEnvironment()
const grant = EndpointGrant.parse(await mailbox.takeGrant(abortSignal))
const [token = ''] = grant.tokens

mailbox.send({ type: 'call', id: 'call-1', endpoint: grant.endpoint, token, call: { type: 'resolve-model', model: 'claude-opus-5-5' } })
const answer = CallAnswer.parse((await mailbox.take('call-1', abortSignal)).value)
// answer.next is the token for the endpoint's next call; answer.outcome the result or the error
```

| Call | Result |
|---|---|
| `{ type: 'tool', tool, input }` | what the host tool returned |
| `{ type: 'open', tools }` | an `EndpointGrant` for a loop that takes only `tools`. Only on the run's endpoint |
| `{ type: 'close', endpoint }` | nothing: the loop's endpoint is closed. Only on the run's endpoint |
| `{ type: 'resolve-model', model }` | a `ResolvedModel`: the first of the user's providers that offers the model |
| `{ type: 'model', request }` | a `ModelResponse`: what the provider answered, with the credential added on the host |

A token is good for one call. One that comes again, or one the endpoint never handed out, closes the endpoint and fails the run: someone else had it. Tokens live only in the runtime's memory, which is why `takeGrant` and `take` remove the files they read.

## The mailbox

`MailboxLayout` names the files in the mailbox directory, which is `/var/lib/mesh-flow/mailbox` by default:

| Path | Written by |
|---|---|
| `start.json` | the engine, before it starts the runtime: a `RunStart`, `{ mode: 'describe' }` or `{ mode: 'run', workflow, trigger?, input? }` |
| `outbox.jsonl` | the runtime, appended, one message per line |
| `inbox/<request id>.json` | the engine, atomically |
| `gateway.json` | the engine, before it starts the runtime: the run's `EndpointGrant`. The runtime removes it once read |
| `runtime.pid`, `runtime.log` | the engine, when it starts the runtime |
| `polls/` | the engine's polls, while they run |

Each message is a single append of a single line, and `JSON.stringify` never writes a raw newline, so a reader never mistakes half a message for a whole one. A line without its newline yet is still being written.
