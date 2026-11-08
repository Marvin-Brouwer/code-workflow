# `@mesh-flow/core`

The mesh-flow authoring vocabulary, and the runtime that runs it inside a sandbox. A workflow is plain async TypeScript: code owns the control flow, and agents are calls inside it. An agent's result only comes through the exit tools in its template.

Agent loops run on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable): conversations, tool calls and turns are stored in SQLite, keyed by the loop's call site, so a run that restarts on the same store picks its conversations up again.

## Usage

### Agents

Agents belong to the workflow repository, not to packages: model, reasoning and system prompt are team specific.

```ts
import { agent, prompt, requestUserInput } from '@mesh-flow/core'

export const developer = agent({
	model: 'claude-sonnet-5-5',
	reasoning: 'medium',
	system: prompt`You are a senior developer. When the plan doesn't fit, ${requestUserInput}.`,
})
```

### Loops and exits

`loop` runs the agent until it calls one of the exits in its template, and resolves to that exit's result. Its type comes from the exits:

```ts
import { fail, limit, propose, succeed, verify } from '@mesh-flow/core'
import { z } from 'zod'

const Plan = z.object({ steps: z.array(z.string()) })

// Plan: a human approves it, or the agent gets their feedback and tries again.
const plan = await planner.loop`Plan ${story}. Propose the plan with ${propose(Plan)}, or ${fail} when it can't be done.`

// void: the agent hands in with verify, and finishes only when the checks pass.
await developer.loop`Implement ${plan}. Hand in with ${verify(tests(repository))}. ${limit({ turns: 40, minutes: 30 })}`

// { title: string }: the checks run before succeed is accepted.
const summary = await developer.loop`Summarise the change with ${succeed(z.object({ title: z.string() }))}, after ${verify(lint(repository))}.`

// string: no exits, so the agent's final text.
const answer = await researcher.loop`What does ${repository} use for logging?`
```

| Exit | Result | |
| --- | --- | --- |
| `succeed()` | `void` | The agent says it's done. |
| `succeed(schema)` | the schema's output | Input that doesn't fit goes back to the agent. |
| `succeed(folder)` | `void` | Done once the workspace folder has its `minFiles`. |
| `propose(schema)` | the schema's output | A human approves it; a rejection goes back to the agent with the feedback. |
| `fail` | never | The loop rejects with `AgentGaveUp`. |
| `verify(...checks)` | `void` | Alone, how the agent hands in. Next to `succeed` or `propose`, a gate in front of them. Findings go back to the agent; after `maxRejections` (default 5) the loop rejects with `ChecksFailed`. |

`limit({ turns, minutes })` caps a loop. `minutes` counts the agent's own time and stops while it waits on a human. The loop rejects with `LoopLimitExceeded` when a limit runs out, `ExitNotCalled` when the agent stops without an exit three times after a reminder, and `LoopFailed` when the model fails or hits its context limit. There is no compaction.

A tool that throws ends the loop with that error, after the current round. Input that doesn't fit a tool's schema goes back to the agent instead.

### Tools

A tool is also a function: interpolated into a template, the agent can call it; called from code, it runs with the run's signal.

```ts
import { tool } from '@mesh-flow/core'
import { z } from 'zod'

export const readTicket = tool('readTicket', {
	description: 'Reads a ticket by its key',
	input: z.object({ key: z.string() }),
	action: async ({ key }, { signal }) => tickets.read(key, signal),
})

const ticket = await readTicket({ key: 'ABC-1' })
await developer.loop`Fix ${ticket}. Look up related tickets with ${readTicket}.`
```

An agent becomes a tool for another agent with `as`. With `verify`, its work has to pass those checks before the tool returns:

```ts
await reviewer.loop`Review ${mergeRequest}. Ask ${developer.as('changeCode', { in: repository, verify: [tests(repository)] })} for code changes.`
```

### Checks

A check returns findings; no findings means it passed. Checks run concurrently when the agent hands in.

```ts
import { check } from '@mesh-flow/core'

export const tests = (repository: Repository) =>
	check('tests', async ({ signal }) => {
		const { failures } = await repository.run('dotnet test', signal)
		return failures.map((failure) => ({ source: failure.test, message: failure.message }))
	})
```

### Values in prompts

Values render themselves: tools as their name, a nested `prompt` in place, a value with a `toPrompt` method as what that returns, strings as they are, and anything else as indented JSON. Templates are dedented.

```ts
import { toPrompt, workspace } from '@mesh-flow/core'

const story = { key: 'ABC-1', [toPrompt]: () => 'stories/ABC-1.md' }
const research = workspace.folder('research', { description: 'one file per finding', minFiles: 1 })

await researcher.loop`Research ${story}. Write your findings to ${research} and finish with ${succeed(research)}.`
const findings = await research.files()
```

### Humans

`input` asks the person running the workflow and waits. The wait is engine-side, so the sandbox can pause meanwhile. An answer that doesn't fit the fields is asked again.

```ts
import { input } from '@mesh-flow/core'
import { z } from 'zod'

const { key } = await input('Which story?', { key: z.string() })
```

### Workflows

`workflow` names the body. Under the engine, the file starts itself: `node workflows/develop.mts` runs it on the sandbox's mailbox, stops on `SIGTERM` or `SIGINT`, and exits with 0 or 1.

```ts
import { inDependencyOrder, workflow } from '@mesh-flow/core'

export default workflow('develop', async () => {
	const plan = await planner.loop`Plan ${story} with ${propose(Plan)}.`
	await inDependencyOrder(plan.parts, async (part, upstream) => {
		await developer.loop`Implement ${part}, using ${upstream}. Hand in with ${verify(tests(part.repository))}.`
	})
})
```

`inDependencyOrder` starts each node once the nodes it depends on have returned, so independent nodes run concurrently. A failed node blocks only the nodes that depend on it; the others go on, and the call rejects with `DependencyOrderFailed`, which holds every result, failure and blocked node.

Anywhere else, such as in a test, run it with a channel of your own:

```ts
import { runWorkflow } from '@mesh-flow/core'

const outcome = await runWorkflow(develop, { channel, signal, models, workspace: 'workspace' })
```

Under the engine the workspace is `~/workspace` and the agents' store is `~/.mesh-flow/agents.sqlite`.

## Events

Every workflow, loop, turn, tool call, exit call, input and dependency node is an event in a tree: each has an `id` and the `parentId` of the event it happened in, and ends with a `-succeeded` or `-failed` event. They go to the engine as they happen.

## Stopping

Every tool gets an `AbortSignal`. When the run is stopped, waits end at once with the signal's reason, the model call is aborted, and the run settles even when a tool ignores its signal: the body gets two seconds to settle, closing the agents' store gets two more.

## Known gaps

- Model providers come with the gateway. Until then a loop in an engine run fails up front with a clear error; `runWorkflow` takes `models` directly.
- Tools run in the workflow process. Per-loop gateway endpoints, and the agent shell as a separate unprivileged user, come with the gateway.
- A restarted run picks its conversations up only on the same agents' store.

## Development

```sh
pnpm --filter @mesh-flow/core typecheck
pnpm --filter @mesh-flow/core test
pnpm --filter @mesh-flow/core build
```

Tests run against a scripted model (Pi's faux provider), so they need no credentials and no network.
