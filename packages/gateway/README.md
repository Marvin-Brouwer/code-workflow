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
await home.providers.put({ name: 'anthropic', kind: 'anthropic' }, abortSignal)
await home.providers.put({ name: 'router', kind: 'openrouter' }, abortSignal)
```

Every read opens the file again, so a secret set with the CLI counts at once in a running engine.

## Model providers

A provider is one of pi-ai's providers (`anthropic`, `openai`, `openrouter`, `groq`, ...) under a name of the user's, with an optional base URL of its own and its API key in the credential store as `provider/<name>`. The order matters: an agent names a model id, and the gateway resolves it **model first**, to the first provider that offers it.

`gateway.unavailableModels(models, abortSignal)` says why each of a list of models can't run now, which a trigger uses to refuse a run before it starts.

The provider's SDK runs in the sandbox, as pi-ai always runs it, and makes the provider's own request. The gateway only checks it and adds the key:

- the path has to be the model API's request path (`/v1/messages`, `/chat/completions`, `/responses`), and the body has to be for the model the call names, so the key does nothing but model calls;
- whatever credential headers the sandbox sent are dropped;
- usage and cost are counted per run and model, from the provider's own usage fields and pi-ai's prices.

The gateway sends the Anthropic Messages, OpenAI Chat Completions and OpenAI Responses APIs, with an API key. Providers on other APIs (Google, Bedrock, Mistral) and subscription logins come later.

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

## Endpoints and tokens

```ts
import { openGateway, openGatewayHome } from '@mesh-flow/gateway'

const abortSignal = AbortSignal.timeout(10_000)
const home = await openGatewayHome('/home/me/.local/share/mesh-flow/gateway', abortSignal)
const gateway = openGateway({ home: home.directory, credentials: home.credentials, providers: home.providers, tools: [] })

// Before the runtime starts: the run's own endpoint, for the host tools its app lists.
const grant = await gateway.openRun('run-1', ['githubComment'], abortSignal)

// For every call the engine reads from the mailbox:
// const accepted = await gateway.accept('run-1', message, abortSignal)
// ...save that the message was read, then
// const answer = await accepted.answer(abortSignal) // write it to the inbox, then
// await gateway.settle('run-1', message.id, abortSignal)
```

- **A run's endpoint** takes calls from workflow code, the model calls, and opening and closing loop endpoints.
- **A loop's endpoint** takes only the tools in that loop's template. The runtime opens it when the loop starts and closes it when the loop settles.
- **Every token is good for one call**, and the answer carries the next. An endpoint hands out four at a time, so calls can run at the same time. A token that comes again, or one never handed out, closes every endpoint of the run and `accept` says so in `compromised`: the engine fails the run.
- **Only hashes of tokens are kept on disk**, in `runs/<run>.json`, so a run paused across an engine restart can go on calling. A call that was taken but not answered when the engine stopped is answered as interrupted after the restart, with its next token: whether it took effect is unknown, so it isn't run again.
- **Aborting a call settles it promptly**, also when the host tool ignores its signal.

## Not yet

- **The agent's shell as a separate user.** Tokens live in the runtime's memory and the mailbox is the runtime's user's only, which keeps an agent out only once its shell commands run as another user ([gateway rule 5](../../docs/plans/gateway-tool-calls.md#rules)).
- **Streaming model responses.** A model call's answer comes back whole, because the mailbox carries whole messages. The SDK in the sandbox reads it as the stream it would have read.
- **Connector host tools in the engine.** The gateway takes host tools as a list; which connector packages an engine loads them from is decided with the first connector.
