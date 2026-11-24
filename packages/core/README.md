# `@mesh-flow/core`

The mesh-flow authoring vocabulary, and the runtime that runs it inside a sandbox. A workflow is plain async TypeScript: code owns the control flow, and agents are calls inside it. An agent's result only comes through the exit tools in its template.

Agent loops run on [Pi Durable](https://www.npmjs.com/package/@earendil-works/pi-durable). Conversations, tool calls and turns are stored in SQLite, keyed by the loop's call site, so a run that starts again on the same store is cheap: see [Reruns](#reruns).

## Usage

The samples share an `agents.mts` like this one. Agents belong to the workflow repository, not to packages: model, reasoning and system prompt are team specific.

Calls to `loop`, tools and `input` run inside a workflow body (see [Workflows](#workflows)); the samples leave the body out. What starts a workflow is in [Triggers](#triggers).

```ts
import { agent, prompt, requestUserInput } from '@mesh-flow/core'

// Runs on the first of these models that a provider with a key offers.
export const planner = agent({
	model: ['claude-opus-5-5', 'gpt-5.5'],
	reasoning: 'high',
})

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
import { check, duration, fail, limit, propose, succeed, verify } from '@mesh-flow/core'
import { z } from 'zod'
import { developer, planner } from './agents.mts'

const story = 'stories/ABC-1.md'
const Plan = z.object({ steps: z.array(z.string()) })
const lint = check('lint', async () => [])
const implementationTime = duration.of('30m')

// Plan: a human approves it, or the agent gets their feedback and tries again.
const plan = await planner.loop`Plan ${story}. Propose the plan with ${propose(Plan)}, or ${fail} when it can't be done.`

// void: the agent hands in with verify, and finishes only when the checks pass.
await developer.loop`Implement ${plan}. Hand in with ${verify(lint)}. ${limit({ turns: 40, time: implementationTime })}`

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

`limit({ turns, time })` caps a loop. `time` is a `Duration` (`duration.of('30m')`, from `@mesh-flow/duration`, also exported here) and counts the agent's own time, and stops while it, or an agent it called as a tool, waits on a human. The loop rejects with:
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

`describe` titles a call in the UI's run view, from its input and what it returned. Without it, the call is titled by the tool's name:

```ts
import { tool } from '@mesh-flow/core'
import { z } from 'zod'

const tickets = new Map([['ABC-1', 'The login button does nothing on Safari.']])

export const readTicket = tool('readTicket', {
	input: z.object({ key: z.string() }),
	action: async ({ key }) => tickets.get(key),
	describe: ({ key }, ticket) => (ticket === undefined ? `Found no ticket ${key}` : `Read ticket ${key}`),
})
```

A tool settles as soon as its signal aborts, even when its action doesn't: the call is wrapped in `untilAborted(promise, abortSignal)`, which packages can use for their own waits too.

An agent becomes a tool for another agent with `as`. With `verify`, its work has to pass those checks before the tool returns:

```ts
import { check } from '@mesh-flow/core'
import { developer, reviewer } from './agents.mts'

const tests = check('tests', async () => [])

await reviewer.loop`Review the change in web/. Ask ${developer.as('changeCode', { in: 'web/', verify: [tests] })} for code changes.`
```

### Host tools

A tool that needs a credential runs on the host, in the gateway, and the workflow has its stub. A connector defines it once and hands the definition to `hostTool` in `@mesh-flow/gateway` and to `hostToolStub` here. The stub is a tool like any other: called from code it runs on the run's endpoint, interpolated in a loop the agent calls it on that loop's own endpoint, which takes only the loop's host tools and closes when the loop settles.

```ts
import { agent, hostToolStub } from '@mesh-flow/core'
import { z } from 'zod'

export const commentDefinition = {
	name: 'githubComment',
	description: 'Comment on a GitHub issue',
	input: z.object({ issue: z.number(), body: z.string() }),
	output: z.object({ posted: z.boolean() }),
}
export const comment = hostToolStub(commentDefinition)

await comment({ issue: 12, body: 'On it.' })
await agent({ model: 'claude-opus-5-5' }).loop`Tell the reporter what you found with ${comment}.`
```

The input is checked by the stub and again on the host, and the result against `output`. When the host says no, the stub throws a `GatewayCallError`; its `transient` says the failure may pass on another try (a dropped connection, a service that was down, an engine restart mid-call). The app's build lists every stub its modules make, and a run's gateway takes only those.

### Models

An agent names a model id, or several in the order they're tried. Under the engine its model comes through the gateway: the ids are resolved on the host, model first, to the agent's first model that a provider of the app's config with a key offers, on the first such provider in the config's order (see [Apps](#apps)). The model is picked when a loop starts, and a loop doesn't move to another model when a call fails. pi-ai runs the provider's own request in the sandbox with a key that means nothing, and its `fetch` hands the request to the gateway, which sends it with the real key and counts the usage. Outside the engine, `runWorkflow` takes `models` directly.

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

A workspace file or folder can be made at module level; inside a run, `location()` says where it is on disk, for code that hands the path to something else, such as git. In a prompt it renders as that absolute path, so the agent still finds it after it has changed into a checkout.

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

### Waiting

A workflow waits for the thing itself, never for an amount of time: `await github.review(pullRequest, handlers)` returns when the pull request is merged or closed, `verify(github.checksPass(pullRequest))` when its checks have completed. Days can pass in such an `await`. The run is paused meanwhile and resumes where it was, so a workflow that waits costs nothing and survives an engine restart.

```ts
const outcome = await github.review(pullRequest, { comments: handleComments })
if (outcome.state === 'merged') await github.close(issue)
```

Each of these functions is a connector's, and how it waits is the connector's concern, not the workflow's. Today they look at GitHub at an interval; the engine is to deliver webhook events into waiting runs ([design: Triggers](../../docs/design.md#triggers)), after which they wait for the event instead, without a change to their signature.

A connector waits with `wait`: a pause on the engine's clock, so the sandbox can be paused meanwhile and a timer that disagrees across a pause never matters. Inside a loop, as from a check that waits for a pipeline, the wait doesn't count toward the loop's `limit`. It belongs in a connector's function, behind an `await` that names what the workflow waits for, not in workflow code.

```ts
import { duration, hostToolStub, wait } from '@mesh-flow/core'
import { z } from 'zod'

const pipeline = hostToolStub({
	name: 'ciPipeline',
	description: 'Reads a pipeline of the build server',
	input: z.object({ id: z.string() }),
	output: z.object({ done: z.boolean() }),
})

const lookEvery = duration.of('30s')

/** Returns once the pipeline has finished: what a workflow awaits. */
export async function finished(id: string): Promise<void> {
	while (!(await pipeline({ id })).done) await wait(lookEvery)
}
```

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

### Apps

An app is a package whose `main` in `package.json` is its entry file. The entry file exports `defineMeshFlow`: the sandbox the app's runs get, the model providers its agents run on, and everything that can start a run, so there is one place to see what is live and where it runs:

```json
{ "name": "example", "type": "module", "main": "main.mts" }
```

```ts
import { anthropicClaude, defineMeshFlow, image, openRouter, schedule, userTrigger, webhook } from '@mesh-flow/core'
import { npmRegistry } from '@mesh-flow/toolchain-node'
import { z } from 'zod'
import { develop, weeklyReport } from './workflows/develop.mts'

const StoryLabeled = z.object({
	action: z.literal('labeled'),
	label: z.object({ name: z.literal('ai-develop') }),
	story: z.object({ key: z.string() }),
})

/** The parameters `develop` starts with, from a labeled story. */
const StoryToDevelop = StoryLabeled.transform((event) => ({ story: event.story.key }))

// Signed with the default secret header, `x-webhook-secret`; the tracker names each delivery.
const onStoryLabeled = webhook(develop, StoryToDevelop, { deliveryHeader: 'x-delivery-id' })

export default defineMeshFlow({
	sandbox: image({
		name: 'node:26-slim',
		memoryMb: 4096,
		registries: [npmRegistry],
	}),
	// In order: a model goes to the first provider here that offers it and has a key.
	modelProviders: [
		anthropicClaude,
		openRouter({
			name: 'team-openrouter',
			baseUrl: 'https://llm-proxy.example.com/api/v1',
		}),
	],
	workflows: [
		// A button in the UI, with the story's key as its form.
		userTrigger(develop),
		// A story labeled `ai-develop` in the tracker.
		onStoryLabeled,
		// Every Monday at midnight.
		schedule(weeklyReport, 'weekly'),
	],
})
```

`image({ name, cpus?, memoryMb?, registries? })` is the sandbox: an image with `node` in it, 2 CPUs and 2048 MB unless you say otherwise, and the package registries it restores from (see [Packages](#packages)). `mesh-flow build` bundles the entry file with its dependencies and writes down what it declares, so the sandbox has nothing to install and only runs `node` (see [`@mesh-flow/build`](../build/README.md)).

A provider comes from its factory: `anthropicClaude`, `openAi`, `openRouter`, `groq`, `deepSeek`, `xAi` or `githubCopilot`, listed as it is or called with `{ name?, baseUrl? }`: a name of its own, which its key is set under, and a base URL for a proxy. Each is named after its kind by default. `githubCopilot` can be listed but serves no model calls yet: it needs a GitHub sign-in exchanged for a Copilot token, which the gateway doesn't do yet (#65). A server that speaks the OpenAI chat completions API, such as a LiteLLM proxy, comes from `openAiCompatible({ name, baseUrl })`. The server says which models it offers (`GET <baseUrl>/models`, with the user's key) when a loop picks its model, so the config doesn't list them and the build check counts it as offering any model. `modelProvider(kind, { name?, baseUrl? })` makes one of any other pi-ai provider kind. The providers, their order and their base URLs are team policy, reviewed in git: a base URL decides where prompts and code go. Each user only sets a provider's key (`mesh-flow provider key <name>`, or in the UI), and can leave one without a key. `mesh-flow build` fails when an agent's model isn't offered by any provider listed here.

`defineWorkflows(...triggers)` bundles triggers, for a package or a module that brings several at once. A bundle goes in `workflows` like a trigger does:

```ts
import { defineWorkflows, userTrigger, webhook } from '@mesh-flow/core'
import { fixIssue, IssueLabeled } from './workflows/fix-issue.mts'

/** The parameters `fixIssue` starts with, from a labeled issue. */
const IssueToFix = IssueLabeled.transform((event) => ({ issue: event.issue.number }))

const onIssueLabeled = webhook(fixIssue, IssueToFix)

export const issueTriggers = defineWorkflows(
	userTrigger(fixIssue),
	onIssueLabeled,
)
```

A trigger listed twice, in the app or across its bundles, is an error.

### Packages

The sandbox has no network. Package managers in it still restore from the registries the app's `image` lists, with their own config and no changes to a repository. A registry is one of these:

- A public one, which the package of its ecosystem defines, such as `nugetOrg` from [`@mesh-flow/toolchain-dotnet`](../toolchain-dotnet/README.md) and `npmRegistry` from [`@mesh-flow/toolchain-node`](../toolchain-node/README.md).
- A connector's own, such as `codeArtifact(...)` from [`@mesh-flow/aws`](../aws/README.md).

How a fetch goes:

- Every run that lists registries serves a proxy on loopback, and every process the workflow and its agents start has `HTTPS_PROXY` pointing at it, so `npm ci` and `dotnet restore` go through it.
- For a registry's host it ends TLS itself, with a certificate from an authority made for that run in the sandbox, which those processes trust through `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE` and `REQUESTS_CA_BUNDLE`. Nothing outside the sandbox trusts that authority, and its key never leaves the runtime. Those variables replace the system's trust store for the processes, so HTTPS in the sandbox with any other certificate, such as a local dev server's, doesn't verify; loopback and the sandbox's own host name aren't sent to the proxy.
- Each `GET` it gets is a call to the gateway, which fetches the package on the host, with the connector's credential for a connector's registry. A host with several registries, such as two CodeArtifact repositories in one domain, sends each fetch to the registry whose path it's below. Other hosts and paths, plain HTTP and writes are refused. A fetch takes at most `maxPackageBytes` of `@mesh-flow/gateway` (256 MB). A fetch the gateway refuses is a 403, so a package manager doesn't try it again; one that failed for now, such as a registry that's down, is a 502. A redirect from a public registry is handed back to the package manager, not followed; one from a connector's registry, such as to a signed download URL, is followed on the host.
- The engine writes each fetched body into the sandbox as a file, and the proxy streams it from there and removes it, so a package isn't held in the runtime's memory. The gateway keeps the packages it fetched on the host, so a warm restore doesn't go to the registry.
- Package fetches go on the run's package endpoint, with `tokensPerPackageEndpoint` (eight) tokens of their own, so at most that many go at once and a restore doesn't hold up the workflow's tool and model calls.

Code can make the same call itself, with `fetchPackage`:

```ts
import { fetchPackage, workflow } from '@mesh-flow/core'
import { nugetOrg } from '@mesh-flow/toolchain-dotnet'
import { z } from 'zod'

/** A NuGet version list, as the flat container serves it. */
const PackageVersions = z.object({ versions: z.array(z.string()) })

export const nugetVersions = workflow('nuget-versions', async ({ abortSignal }) => {
	const request = {
		registry: nugetOrg,
		path: '/v3-flatcontainer/newtonsoft.json/index.json',
	}
	const index = await fetchPackage(request, abortSignal)
	const { versions } = PackageVersions.parse(JSON.parse(index.body.toString('utf8')))
	return versions
})
```

It only works inside a run, whose gateway it fetches through.

### Triggers

A workflow never says how it is started; the app's `workflows` does.

- `userTrigger(workflow)` is a button in the UI. The workflow's parameters are its form.
- `webhook(workflow, schema, options?)` starts a run for each delivery that fits the schema. The schema's output has to be the workflow's parameters, so the mapping is a `.transform`. The engine checks the signature and the schema's structure (as JSON Schema) on the host, before it makes a sandbox; `.refine` and `.transform` run in the sandbox, and a delivery they turn down ends the run as skipped. Put filters in the structure where they can go, as literals and enums. The signature is a secret header (`x-webhook-secret` by default) or `hmac-sha256` of the body, such as `{ scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' }` for GitHub. The delivery header names a delivery, so a redelivery reuses its run. A second webhook of the same workflow needs a `name`, which goes into its URL.
- `schedule(workflow, when, parameters?)` starts a run on the engine's clock. `when` is `hourly`, `daily`, `weekly` or `monthly` (at the start of the hour, day, week or month, a week starting on Monday), or a cron expression. The parameters are fixed, and only optional when the workflow needs none.

TypeScript checks every trigger against its workflow: a webhook schema that doesn't give the parameters, or a schedule without them, doesn't compile. Secrets, and turning a trigger on or off, are settings of the engine, never code.

Under the engine, the built entry file starts itself: `node main.mjs` reads what the engine asked for from the mailbox and runs one workflow through one of its triggers, stopped on `SIGTERM` or `SIGINT`, exiting with 0 or 1. A schedule fired by hand (`mesh-flow trigger schedule`) runs with the parameters it was given instead of its own. `mesh-flow build` starts it the same way to have it describe what it declares: its sandbox, its model providers and its agents' models, its workflows with their parameters as JSON Schema, and its triggers. `describeApp(app)` gives the same description in code, for a test of your entry file; it describes the workflows your modules registered, or the ones you pass as its second argument.

### Running a workflow yourself

Anywhere else, such as in a test, run a workflow with a channel of your own. A channel sends the run's messages and answers its requests:

```ts
import { createModels } from '@earendil-works/pi-ai/models'
import { duration, runWorkflow, type RunChannel } from '@mesh-flow/core'
import { develop } from './workflows/develop.mts'

// The providers the agents' models run on: under the engine they come through the gateway.
const models = createModels()
const runFor = duration.of('1h')

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
	abortSignal: runFor.toAbortSignal(),
	workspace: 'workspace',
})
```

Parameters that don't fit fail the run before the body starts. Under the engine the workspace is `~/workspace` and the agents' store is `~/.mesh-flow/agents.sqlite`.

## Reruns

When a run starts again on the same agents' store, as after a crash, a loop is the same loop when its call site, the dependency nodes around it, its count there and what the agent gets (model, reasoning, system prompt and template, as rendered) are the same. The call site is the place in the source. That holds in a built app too, because `mesh-flow build` ships a source map with it: rebuilding doesn't change the call site, but an edit above the call in the same file does. Workspace files and folders render as absolute paths, so a rerun has to use the same workspace directory; under the engine it always does. Then:
- a loop that finished returns the result it finished with, without asking the model or a human again. Results are kept as JSON: one that JSON would change, such as a `Date` or a `bigint` from a schema's transform, isn't kept, and that loop runs again;
- a loop that didn't finish goes on from its conversation, with what the agent did so far, and its `turns` limit counts from 0 again;
- work the earlier attempt left running, such as a model request cut off by the crash, is stopped first, so it never runs outside its loop.

A loop whose input changed, such as the next comment of a list that grew, starts over with a new conversation.

## Events

Every workflow, loop, turn, tool call, exit call, input and dependency node is an event in a tree: each has an `id` and the `parentId` of the event it happened in, and ends with a `-succeeded` or `-failed` event. They go to the engine as they happen. A tool call's `-succeeded` event has what it returned as `result`, as text for reading, with byte arrays shown as their length and cut to 4000 characters (then `resultCut` is set), and its `describe` line as `title`. A `describe` that throws only loses the title. A host tool's stub takes `describe` the same way.

## Stopping

Every tool gets an `AbortSignal`. When the run is stopped, waits end at once with the signal's reason, the model call is aborted, and the run settles even when a tool ignores its signal: the body gets two seconds to settle, closing the agents' store gets two more.

## Known gaps

- Tools without a credential run in the workflow process, and so does the agent's shell: it isn't a separate unprivileged user yet, so it could read the runtime's gateway tokens. Rotation catches a stolen token; the separate user would prevent it.
- A model's response comes back whole, not streamed.
- The models a trigger checks are those of every agent the app's modules make, not only the started workflow's: one model nobody serves holds up every workflow of the app.

## Development

```sh
pnpm --filter @mesh-flow/core typecheck
pnpm --filter @mesh-flow/core test
pnpm --filter @mesh-flow/core build
```

Tests run against a scripted model (Pi's faux provider), so they need no credentials and no network.
