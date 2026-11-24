# `@mesh-flow/gateway`

The host side of every call that needs a credential. A mesh-flow run lives in a sandbox that holds no credentials at all; whatever needs one, a host tool such as posting a GitHub comment or a model request, the run asks the gateway for, and the gateway runs it on the host with the credential.

[`@mesh-flow/engine`](../engine/README.md) serves it: it opens a run's endpoint before the runtime starts and hands every call it reads from the sandbox's mailbox to the gateway. Connector packages use it for the host halves of their tools. Workflow code never sees it.

## Credentials

Credentials are kept in one file on the host, sealed with AES-256-GCM. The key is in the OS keychain (macOS Keychain, Windows Credential Manager, the Secret Service on Linux), or, where there is none, such as a headless Linux or WSL, in `store.key` next to the file, readable by its owner only. Never in the sandbox, never in git, never in a `.env` file.

```ts
import { openGatewayHome } from '@mesh-flow/gateway'

const abortSignal = AbortSignal.timeout(10_000)
const home = await openGatewayHome('/home/me/.local/share/mesh-flow/gateway', abortSignal)

await home.credentials.set('provider/anthropic', 'sk-ant-...', abortSignal)
```

Every read opens the file again, so a secret set with the CLI counts at once in a running engine.

## Model providers

The app's config declares its providers, in git: each is one of pi-ai's providers (`anthropic`, `openai`, `openrouter`, `groq`, ...) under a name, with an optional base URL of its own, for a proxy. A provider of kind `openai-compatible` is a server that speaks the OpenAI chat completions API, such as a LiteLLM proxy: it has a base URL, and the server lists its models. `resolve-model` asks it (`GET <baseUrl>/models` with the key) and hands the sandbox the model with the base URL, so the sandbox can build it without pi-ai knowing it. The model's context window, answer size and whether it reasons come from pi-ai's catalog when it knows the id, else from defaults (128,000, 16,384, no). A trigger's model check counts a server that can't list its models now as offering them; `undeclaredModels` at build time does too, since it asks nobody. Only the API key is per user, in the credential store as `provider/<name>`, and a user can leave a provider without one. A run's providers come with `openRun`, from the app version it started on:

```ts
const access = {
	tools: [],
	providers: [
		{ name: 'anthropic', kind: 'anthropic' },
		{ name: 'proxy', kind: 'openrouter', baseUrl: 'https://llm-proxy.example.com/api/v1' },
	],
}
const grant = await gateway.openRun('run-1', access, abortSignal)
```

An agent names a model id, or several in the order they're tried. The gateway resolves them **model first**: the agent's first model that a provider with a key offers, on the first such provider in the config's order.

- `gateway.unavailableModels(providers, agentModels, abortSignal)` says why each agent can't run now: the provider that offers its model has no key, or no provider in the config offers it. A trigger uses it to refuse a run before it starts.
- `undeclaredModels(providers, agentModels)` says which agent models no declared provider kind offers at all, and which kinds the gateway can't send for. `mesh-flow build` fails with those: it's a change to the config, not a setting.

The provider's SDK runs in the sandbox, as pi-ai always runs it, and makes the provider's own request. The gateway only checks it and adds the key:

- the path has to be the model API's request path (`/v1/messages`, `/chat/completions`, `/responses`), and the body has to be for the model the call names, so the key does nothing but model calls;
- whatever credential headers the sandbox sent are dropped;
- usage and cost are counted per run and model, from the provider's own usage fields and pi-ai's prices.

The gateway sends the Anthropic Messages, OpenAI Chat Completions and OpenAI Responses APIs, with an API key. Providers on other APIs (Google, Bedrock, Mistral) and subscription logins come later.

## Packages

A sandbox has no network, so its package fetches come here too: a `package` call names one of the registries the run's app restores from (which `openRun` gets in `registries`) and a path on it. The gateway fetches from the registry as `openRun` got it, never as the call describes it: a registry with other paths or another host is another registry, and is refused.

- **Public registries**, such as `nugetOrg` from `@mesh-flow/toolchain-dotnet` and `npmRegistry` from `@mesh-flow/toolchain-node`: the package of the registry's ecosystem defines its host, the paths below which it serves packages and the paths below those it doesn't (`excludedPaths`, such as npm's `/-/` API). The gateway sends the fetch only when the path is below one of its paths and none of the excluded ones, already normalized. A redirect isn't followed: it goes back as it is, so the next fetch is checked too.
- **A connector's registry**, such as a CodeArtifact repository from `@mesh-flow/aws`: the path has to be below one of the registry's paths, already normalized, and the connector's `ResolveRegistryTarget` says where it goes and with which credential. The gateway follows up to three HTTPS redirects, as to a signed download, and sends the connector's headers to the registry's own host only. A redirect to plain HTTP, or a fourth one, is refused like a fetch that isn't a package fetch: the proxy answers 403.

The registry's answer goes back whole, a 404 too, with only `content-type`, `etag`, `last-modified` and `location` of its headers. The body isn't in the answer: the call's `answer` resolves to it as `staged`, next to the answer, for the engine, which writes it into the sandbox as a file the answer names (see [`@mesh-flow/protocol`](../protocol/README.md)), so the mailbox only carries small JSON. A body larger than `maxPackageBytes` (256 MB) is refused. Reads are tried again as with `retryingFetch`.

A published package never changes, so a `.nupkg` or `.tgz` fetched whole is kept in the gateway's `packages` folder, shared by every run, and the next fetch of it doesn't go to the registry. Version lists and other metadata are fetched each time. A package of a connector's registry is served from the folder only while its connector is loaded, without asking the connector again: one that the configured account can't reach any more is still served. The folder only grows; remove it to clear it. A package that can't be kept, such as on a full disk, is still handed to the run, and an entry that can't be read is fetched again.

A run whose app restores from npm and from a connector's registry opens its endpoint with both:

```ts
import { openGateway, openGatewayHome, type ResolveRegistryTarget } from '@mesh-flow/gateway'
import type { ConnectorRegistry } from '@mesh-flow/protocol'
import { npmRegistry } from '@mesh-flow/toolchain-node'

const abortSignal = AbortSignal.timeout(10_000)
const { directory, credentials } = await openGatewayHome('/srv/mesh-flow/gateway', abortSignal)

const packages: ConnectorRegistry = {
	connector: 'cloud',
	name: 'cloud packages',
	host: 'packages.example.com',
	paths: ['/npm/packages/'],
	settings: {},
}
const cloud: ResolveRegistryTarget = async ({ registry, path }, fetchAbortSignal) => {
	const token = await credentials.get('cloud/token', fetchAbortSignal)
	return {
		url: `https://${registry.host}${path}`,
		headers: { authorization: `Bearer ${token}` },
	}
}

const gateway = openGateway({
	home: directory,
	credentials,
	registries: { cloud },
})
const access = {
	tools: [],
	registries: [npmRegistry, packages],
}
const grant = await gateway.openRun('run-1', access, abortSignal)
```

`missingRegistries(registries)` says which registries' connectors aren't loaded, for a trigger to report before a run starts.

## Host tools

A credentialed tool has a definition that both halves share, a host half that runs here, and a stub in the sandbox from `@mesh-flow/core`. The host half is the only limit on what its credential can do, so it does one thing:

```ts
import { hostTool, type ToolDefinition } from '@mesh-flow/gateway'
import { z } from 'zod'

export const commentDefinition = {
	name: 'githubComment',
	description: 'Comment on a GitHub issue',
	input: z.object({ issue: z.number(), body: z.string() }),
} satisfies ToolDefinition

export const comment = hostTool(commentDefinition, async ({ issue, body }, { credentials, abortSignal }) => {
	const token = await credentials.get('github/token', abortSignal)
	const response = await fetch(`https://api.github.com/repos/team/app/issues/${String(issue)}/comments`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token ?? ''}` },
		body: JSON.stringify({ body }),
		signal: abortSignal,
	})
	return { posted: response.ok }
})
```

The input is checked on the host against the definition's schema, whatever the stub checked.

A tool retries its own transient failures. When one still fails after that, such as a dropped connection or a service answering 5xx, it throws a `HostToolTransientError`: the answer says `transient`, and the stub's caller gets a `GatewayCallError` with `transient: true`, so code that only reads, such as a watch, can look again later. Any other error, such as a bad token, is final. `isTransient(error)` checks the error's `transient` field rather than its class, so an error from a connector's own copy of this package still counts. An engine restart in the middle of a call is answered as transient too, since the call may or may not have run.

```ts
import { hostTool, HostToolTransientError } from '@mesh-flow/gateway'
import { z } from 'zod'

export const status = hostTool({ name: 'serviceStatus', input: z.object({}) }, async (_input, { abortSignal }) => {
	const response = await fetch('https://status.example/api', { signal: abortSignal })
	if (response.status >= 500) throw new HostToolTransientError(`The status page answered ${String(response.status)}.`)
	return response.json()
})
```

Calls that must not overlap, such as two replies to one review comment, go through `oneAtATime()`: calls with the same key run one after another, others side by side, and a call whose signal aborts while it waits is never run.

```ts
import { hostTool, oneAtATime } from '@mesh-flow/gateway'

const perIssue = oneAtATime()

export const comment = hostTool(commentDefinition, ({ issue, body }, { abortSignal }) =>
	perIssue(issue, abortSignal, () => postComment(issue, body, abortSignal)),
)
```

A connector's host half sends its requests through `retryingFetch(fetch, defaultFetchRetry)`: a request the service didn't answer in time, or answered 500, 502, 503, 504 or 429, is sent again after each of its `waits` in turn (1, 2, 4 and 8 seconds by default), or after the wait its `retry-after` asks for. Only reads are, by default, since a write whose answer was lost may have been made; a service whose updates can be sent twice says which with `resends`. `unavailable(status)` and the statuses `unauthorized`, `notFound` and `gone` tell its answers apart.

```ts
import { defaultFetchRetry, readsOnly, retryingFetch } from '@mesh-flow/gateway'

// Reads, and the updates that set a value, which the service may get twice.
const send = retryingFetch(fetch, defaultFetchRetry, (request) => readsOnly(request) || request.method === 'PUT')
```

`projectUrl` is where the footer of a post a connector signs links to, so every connector's footer points at the same place.

A connector package exports its host half from a `host` entry point, as a `ConnectorHost`: a name, and the host tools it brings, made with a directory of the connector's own for what it keeps between calls and the connector's own credentials, those named `<connector>/...`, which it may also write, such as a session it renews. The engine loads the connectors the user added (`mesh-flow connector add @mesh-flow/github`) and gives every run the tools its app lists; `gateway.missingTools(names)` says which of an app's tools no loaded connector brings, so a trigger can refuse the run before a sandbox starts.

```ts
import { connectorHost } from '@mesh-flow/gateway'
import { commentTool } from './tools/comment.mts'

export const connector = connectorHost('github', ({ directory }) => [commentTool(directory)])
```

A connector that reads credentials says which are missing with `missingSettings`, so `mesh-flow deploy`, a trigger and the UI's wizard can ask for them before a run needs them. Each is a line that says what to do and a `fix` that says what sets it, such as `{ kind: 'credential', name: 'github/token' }`; `missingCredentials` makes them from the names the connector reads:

```ts
import { connectorHost, missingCredentials } from '@mesh-flow/gateway'
import { commentTool } from './tools/comment.mts'

export const connector = connectorHost('github', ({ directory }) => [commentTool(directory)], {
	missingSettings: ({ credentials }, abortSignal) =>
		missingCredentials(
			credentials,
			[
				{ name: 'github/token' },
			],
			abortSignal,
		),
})
```

A connector whose service has sessions brings a `login` too, which `mesh-flow login <name>` runs, and the engine when a run waits for a sign-in. It gets the connector's own credentials to write to, and `show`, to tell the user where to approve the sign-in once the service hands out a code:

```ts
import { connectorHost } from '@mesh-flow/gateway'
import { deviceSignIn } from './sign-in.mts'

export const connector = connectorHost('cloud', () => [], {
	login: async ({ credentials, show, abortSignal }) => {
		const { url, code, expiresAt, approved } = await deviceSignIn(abortSignal)
		show({ url, code, expiresAt })
		await credentials.set('cloud/session', await approved, abortSignal)
	},
})
```

A host tool that needs the session and finds none throws a `SignInNeededError` before it changes anything. The run then waits for the sign-in instead of failing, and its stub calls the tool again with the same input:

```ts
import { connectorHost, hostTool, SignInNeededError, type CredentialStore } from '@mesh-flow/gateway'
import { bucketsOf, listBucketsDefinition } from './tools/buckets.mts'

const listBuckets = (credentials: CredentialStore) =>
	hostTool(listBucketsDefinition, async (_input, { abortSignal }) => {
		const session = await credentials.get('cloud/session', abortSignal)
		if (session === undefined) throw new SignInNeededError('cloud')
		return bucketsOf(session, abortSignal)
	})

export const connector = connectorHost('cloud', ({ credentials }) => [listBuckets(credentials)])
```

## Endpoints and tokens

```ts
import { openGateway, openGatewayHome } from '@mesh-flow/gateway'
import type { CallAnswer, CallMessage } from '@mesh-flow/protocol'

const abortSignal = AbortSignal.timeout(10_000)
const home = await openGatewayHome('/home/me/.local/share/mesh-flow/gateway', abortSignal)
const gateway = openGateway({ home: home.directory, credentials: home.credentials, tools: [] })

// Before the runtime starts: the run's own endpoint, for the host tools its app lists. The engine
// writes the grant to the mailbox's `gateway.json`, where the runtime takes it.
const grant = await gateway.openRun('run-1', { tools: ['githubComment'] }, abortSignal)

// When the run resumes, before reading the outbox again: answer what the engine left unanswered.
async function answerInterrupted(writeAnswer: (id: string, answer: CallAnswer) => Promise<void>) {
	for (const call of await gateway.interrupted('run-1', abortSignal)) {
		await writeAnswer(call.id, call.answer)
		await gateway.settle('run-1', call.id, abortSignal)
	}
	// ...then, once the outbox was read past where the cursor was: await gateway.forgetInterrupted('run-1', abortSignal)
}

// For every call the engine reads from the mailbox.
async function serveCall(message: CallMessage, writeAnswer: (answer: CallAnswer) => Promise<void>) {
	const accepted = await gateway.accept('run-1', message, abortSignal)
	if (accepted.compromised !== undefined) throw new Error(accepted.compromised)
	// Save that the message was read here, then run it.
	await writeAnswer(await accepted.answer(abortSignal))
	await gateway.settle('run-1', message.id, abortSignal)
}
```

`accept`, `answer` and `settle` are three steps because the call has to survive an engine restart between them: one taken and not settled is answered as interrupted after a restart, so forgetting `settle` makes every call come back that way. After a resume, call `forgetInterrupted` once the outbox was read past where it was.

- **A run's endpoint** takes calls from workflow code, the model calls, and opening and closing loop endpoints.
- **A run's package endpoint** takes package fetches only, with `tokensPerPackageEndpoint` (eight) tokens of its own, so a restore doesn't hold up the run's other calls. `openRun` opens it, in the grant's `packages`, when the app restores from a registry.
- **A loop's endpoint** takes only the tools in that loop's template. The runtime opens it when the loop starts and closes it when the loop settles.
- **Every token is good for one call**, and the answer carries the next. An endpoint hands out four at a time, so calls can run at the same time. A token that comes again, or one never handed out, closes every endpoint of the run and `accept` says so in `compromised`: the engine fails the run.
- **Only hashes of tokens are kept on disk**, in `runs/<run>.json`, so a run paused across an engine restart can go on calling. A call that was taken but not answered when the engine stopped is answered as interrupted after the restart, with its next token: whether it took effect is unknown, so it isn't run again.
- **Aborting a call settles it promptly**, also when the host tool ignores its signal.

## Not yet

- **The agent's shell as a separate user.** Tokens live in the runtime's memory and the mailbox is the runtime's user's only, which keeps an agent out only once its shell commands run as another user ([gateway rule 5](../../docs/plans/gateway-tool-calls.md#rules)).
- **Streaming model responses.** A model call's answer comes back whole, because the mailbox carries whole messages. The SDK in the sandbox reads it as the stream it would have read.
