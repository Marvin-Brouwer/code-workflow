# `@mesh-flow/core`

The mesh-flow authoring vocabulary, and the runtime that runs it inside a sandbox. A workflow is plain async TypeScript: code owns the control flow, and agents are calls inside it. An agent's result only comes through the exit tools in its template.

Agent loops run on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Conversations, tool calls and turns are stored in SQLite, keyed by the loop's call site, so a run that starts again on the same store is cheap: see [Reruns](#reruns).

## Usage

The samples share an `agents.mts` like this one. Agents belong to the workflow repository, not to packages: model, reasoning and system prompt are team specific.

Calls to `loop`, tools and `input` run inside a workflow body (see [Workflows](#workflows)); the samples leave the body out. What starts a workflow is in [Triggers](#triggers).

```ts
import { agent, prompt, requestUserInput } from '@mesh-flow/core'

export const planner = agent({ model: 'claude-opus-5-5', reasoning: 'high' })

export const developer = agent({
	model: 'claude-sonnet-5-5',
	reasoning: 'medium',
	system: prompt`You are a senior developer. When the plan doesn't fit, ${requestUserInput}.`,
})

export const reviewer = agent({ model: 'claude-opus-5-5' })
```

### Loops and exits

`loop` runs the agent until it calls one of the exits in its template, and resolves to that exit's result. Its type comes from the exits:

```ts
import { check, fail, limit, propose, succeed, verify } from '@mesh-flow/core'
import { z } from 'zod'
import { developer, planner } from './agents.mts'

const story = 'stories/ABC-1.md'
const Plan = z.object({ steps: z.array(z.string()) })
const lint = check('lint', async () => [])

// Plan: a human approves it, or the agent gets their feedback and tries again.
const plan = await planner.loop`Plan ${story}. Propose the plan with ${propose(Plan)}, or ${fail} when it can't be done.`

// void: the agent hands in with verify, and finishes only when the checks pass.
await developer.loop`Implement ${plan}. Hand in with ${verify(lint)}. ${limit({ turns: 40, minutes: 30 })}`

// { title: string }: the checks run before succeed is accepted.
const summary = await developer.loop`Summarise the change with ${succeed(z.object({ title: z.string() }))}, after ${verify(lint)}.`

// string: no exits, so the agent's final text.
const answer = await planner.loop`What does ${story} ask for, in one sentence?`
```

| Exit | Result | |
| --- | --- | --- |
| `succeed()` | `void` | The agent says it's done. |
| `succeed(schema)` | the schema's output | Input that doesn't fit goes back to the agent. |
| `succeed(folder)` | the folder (`WorkspaceFolder`) | Done once the workspace folder has its `minFiles`. |
| `propose(schema)` | the schema's output | A human approves it; a rejection goes back to the agent with the feedback. |
| `fail` | never | The loop rejects with `AgentGaveUp`. |
| `verify(...checks)` | `void` | Alone, how the agent hands in. Next to `succeed` or `propose`, a gate in front of them. Findings go back to the agent; after `maxRejections` (default 5) the loop rejects with `ChecksFailed`. |

Exits and limits go in the loop's own template, never in a nested `prompt` or a system prompt: that's where `loop` reads its result type from.

`limit({ turns, minutes })` caps a loop. `minutes` counts the agent's own time, and stops while it, or an agent it called as a tool, waits on a human. The loop rejects with:
- `LoopLimitExceeded` when a limit runs out;
- `ExitNotCalled` when the agent stops without an exit, and still does after three reminders;
- `LoopFailed` when the model fails or hits its context limit. There is no compaction.

A tool, a check or an exit that throws ends the loop with that error, after the current round. Input from the agent that doesn't fit a tool's schema goes back to the agent instead.

### Tools

A tool is also a function. Interpolated into a template, the agent can call it. Called from code inside a run, it gets the run's signal; outside a run, pass `{ abortSignal }`.

```ts
import { tool } from '@mesh-flow/core'
import { z } from 'zod'
import { developer } from './agents.mts'

const tickets = new Map([['ABC-1', 'The login button does nothing on Safari.']])

export const readTicket = tool('readTicket', {
	description: 'Reads a ticket by its key',
	input: z.object({ key: z.string() }),
	action: async ({ key }) => tickets.get(key) ?? `No ticket ${key}.`,
})

const ticket = await readTicket({ key: 'ABC-1' })
await developer.loop`Fix this: ${ticket} Look up related tickets with ${readTicket}.`
```

An agent becomes a tool for another agent with `as`. With `verify`, its work has to pass those checks before the tool returns:

```ts
import { check } from '@mesh-flow/core'
import { developer, reviewer } from './agents.mts'

const tests = check('tests', async () => [])

await reviewer.loop`Review the change in web/. Ask ${developer.as('changeCode', { in: 'web/', verify: [tests] })} for code changes.`
```

### Checks

A check returns findings; no findings means it passed. Checks run concurrently when the agent hands in.

```ts
import { readFile } from 'node:fs/promises'
import { check } from '@mesh-flow/core'

export const noTodos = check('no TODOs', async ({ abortSignal }) => {
	const source = await readFile('web/src/app.ts', { encoding: 'utf8', signal: abortSignal })
	return source.includes('TODO') ? [{ source: 'web/src/app.ts', message: 'Resolve the TODO before handing in.' }] : []
})
```

### Values in prompts

Values render themselves: tools as their name, a nested `prompt` in place, a value with a `[toPrompt]` method (the exported symbol) as what that returns, strings as they are, and anything else as indented JSON. Templates are dedented.

```ts
import { succeed, toPrompt, workspace } from '@mesh-flow/core'
import { planner } from './agents.mts'

const story = { key: 'ABC-1', [toPrompt]: () => 'stories/ABC-1.md' }
const research = workspace.folder('research', { description: 'one file per finding', minFiles: 1 })

await planner.loop`Research ${story}. Write your findings to ${research} and finish with ${succeed(research)}.`
const findings = await research.files()
```

### Humans

`input` asks the person running the workflow and waits. The wait is engine-side, so the sandbox can pause meanwhile. The fields are a form: any zod schema, or one of the common kinds, `input.text()`, `input.yesNo()`, `input.choice(options)` and `input.choices(options)`. An answer that doesn't fit the fields is asked again.

```ts
import { input } from '@mesh-flow/core'
import { z } from 'zod'

const { key } = await input('Which story?', { key: z.string().regex(/^[A-Z]+-\d+$/) })
const release = await input('How should the release go?', {
	tagged: input.yesNo('Is the release tagged yet?'),
	channel: input.choice(['stable', 'beta']),
	platforms: input.choices(['web', 'ios', 'android']),
})
```

An agent asks with `requestUserInput`: one question with a text answer, or a form with the same kinds of field.

### Workflows

`workflow` names a body and says what a run of it starts with: its parameters, as a zod shape like `input`'s fields. The body gets them, checked, next to the run's `abortSignal`. A workflow without parameters leaves them out.

```ts
import { check, inDependencyOrder, propose, verify, workflow } from '@mesh-flow/core'
import { z } from 'zod'
import { developer, planner } from '../agents.mts'

const Plan = z.object({ parts: z.array(z.object({ id: z.string(), dependsOn: z.array(z.string()), task: z.string() })) })
const tests = check('tests', async () => [])

export const develop = workflow('develop', { story: z.string().regex(/^[A-Z]+-\d+$/) }, async ({ parameters }) => {
	const plan = await planner.loop`Plan stories/${parameters.story}.md in parts with ${propose(Plan)}.`
	await inDependencyOrder(plan.parts, async (part, upstream) => {
		await developer.loop`Do ${part.task}, after ${upstream}. Hand in with ${verify(tests)}.`
	})
})

export const weeklyReport = workflow('weekly-report', async ({ abortSignal }) => {
	// ...
})
```

`inDependencyOrder` starts each node once the nodes it depends on have returned, so independent nodes run concurrently. A failed node blocks only the nodes that depend on it; the others go on, and the call rejects with `DependencyOrderFailed`, which holds every result, failure and blocked node.

### Triggers

A workflow never says how it is started. The entry file, `workflows/main.mts`, lists everything that can start a run, so there is one place to see what is live:

```ts
import { defineWorkflows, schedule, userTrigger, webhook } from '@mesh-flow/core'
import { z } from 'zod'
import { develop, weeklyReport } from './develop.mts'

const StoryLabeled = z.object({
	action: z.literal('labeled'),
	label: z.object({ name: z.literal('ai-develop') }),
	story: z.object({ key: z.string() }),
})

export default defineWorkflows(
	userTrigger(develop),
	webhook(develop, StoryLabeled.transform((event) => ({ story: event.story.key })), {
		signature: { scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' },
		deliveryHeader: 'x-github-delivery',
	}),
	schedule(weeklyReport, '0 7 * * 1'),
)
```

- `userTrigger(workflow)` is a button in the UI. The workflow's parameters are its form.
- `webhook(workflow, schema, options?)` starts a run for each delivery that fits the schema. The schema's output has to be the workflow's parameters, so the mapping is a `.transform`. The engine checks the signature and the schema's structure (as JSON Schema) on the host, before it makes a sandbox; `.refine` and `.transform` run in the sandbox, and a delivery they turn down ends the run as skipped. Put filters in the structure where they can go, as literals and enums. The signature is a secret header (`x-webhook-secret` by default) or `hmac-sha256` of the body. The delivery header names a delivery, so a redelivery reuses its run. A second webhook of the same workflow needs a `name`, which goes into its URL.
- `schedule(workflow, cron, parameters?)` starts a run on the engine's clock. The parameters are fixed, and only optional when the workflow needs none.

TypeScript checks every trigger against its workflow: a webhook schema that doesn't give the parameters, or a schedule without them, doesn't compile. Secrets, and turning a trigger on or off, are settings of the engine, never code.

Under the engine, the entry file starts itself: `node workflows/main.mts` reads what the engine asked for from the mailbox, and either describes what it declares (its workflows, their parameters as JSON Schema, its triggers) or runs one workflow by name, stopped on `SIGTERM` or `SIGINT`, exiting with 0 or 1. It can run any workflow its modules define, also one no trigger lists, which is how the CLI's `mesh-flow run <name>` works. `describeEntry(entry)` gives the same description in code, for a test of your entry file.

### Running a workflow yourself

Anywhere else, such as in a test, run a workflow with a channel of your own. A channel sends the run's messages and answers its requests:

```ts
import { createModels } from '@earendil-works/pi-ai/models'
import { runWorkflow, type RunChannel } from '@mesh-flow/core'
import { develop } from './workflows/develop.mts'

// The providers the agents' models run on: under the engine they come from the gateway.
const models = createModels()
const anHourMs = 60 * 60_000

const channel: RunChannel = {
	send: (message) => {
		console.log(message)
	},
	// Approves every proposal.
	answer: async () => ({ value: { approved: true } }),
}

const outcome = await runWorkflow(develop, {
	parameters: { story: 'ABC-1' },
	channel,
	models,
	abortSignal: AbortSignal.timeout(anHourMs),
	workspace: 'workspace',
})
```

Parameters that don't fit fail the run before the body starts. Under the engine the workspace is `~/workspace` and the agents' store is `~/.mesh-flow/agents.sqlite`.

## Reruns

When a run starts again on the same agents' store, as after a crash, a loop is the same loop when its call site, the dependency nodes around it, its count there and what the agent gets (model, reasoning, system prompt and template, as rendered) are the same. Then:
- a loop that finished returns the result it finished with, without asking the model or a human again. Results are kept as JSON: one that JSON would change, such as a `Date` or a `bigint` from a schema's transform, isn't kept, and that loop runs again;
- a loop that didn't finish goes on from its conversation, with what the agent did so far, and its `turns` limit counts from 0 again;
- work the earlier attempt left running, such as a model request cut off by the crash, is stopped first, so it never runs outside its loop.

A loop whose input changed, such as the next comment of a list that grew, starts over with a new conversation.

## Events

Every workflow, loop, turn, tool call, exit call, input and dependency node is an event in a tree: each has an `id` and the `parentId` of the event it happened in, and ends with a `-succeeded` or `-failed` event. They go to the engine as they happen.

## Stopping

Every tool gets an `AbortSignal`. When the run is stopped, waits end at once with the signal's reason, the model call is aborted, and the run settles even when a tool ignores its signal: the body gets two seconds to settle, closing the agents' store gets two more.

## Known gaps

- Model providers come with the gateway. Until then a loop in an engine run fails up front with a clear error; `runWorkflow` takes `models` directly.
- Tools run in the workflow process. Per-loop gateway endpoints, and the agent shell as a separate unprivileged user, come with the gateway.

## Development

```sh
pnpm --filter @mesh-flow/core typecheck
pnpm --filter @mesh-flow/core test
pnpm --filter @mesh-flow/core build
```

Tests run against a scripted model (Pi's faux provider), so they need no credentials and no network.
