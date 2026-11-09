import { text } from 'node:stream/consumers'
import { knownKinds, providerCredential, ProviderName, type GatewayHome } from '@mesh-flow/gateway'
import type { Command } from 'commander'

/** How long a provider command may take: it only reads and writes files in the engine's home. */
const providerCommandMs = 30_000

function signal(): AbortSignal {
	return AbortSignal.timeout(providerCommandMs)
}

/**
 * `mesh-flow provider ...`: the user's model providers, in order, and their API keys. They work on
 * the engine's home directly, so they work without a running engine, and a running one sees the
 * change at once.
 */
export function addProviderCommands(program: Command, gateway: (abortSignal: AbortSignal) => Promise<GatewayHome>): void {
	const provider = program
		.command('provider')
		.description('Model providers, in order: an agent gets the first one that offers its model. Keys stay on this machine.')

	provider
		.command('add')
		.description('Adds a provider at the end of the list, or changes one, and sets its API key from stdin when one is piped in.')
		.argument('<name>', 'your name for it, such as anthropic or work-openrouter')
		.requiredOption('--kind <kind>', 'which provider it is: see `mesh-flow provider kinds`')
		.option('--base-url <url>', "another base URL than the kind's, for a proxy or a compatible server")
		.action(async (name: string, options: { kind: string; baseUrl?: string }) => {
			const abortSignal = signal()
			if (!knownKinds().some((known) => known.kind === options.kind))
				throw new Error(`There is no provider kind ${options.kind}. See \`mesh-flow provider kinds\`.`)
			const home = await gateway(abortSignal)
			const checked = ProviderName.parse(name)
			const baseUrl = options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }
			await home.providers.put({ name: checked, kind: options.kind, ...baseUrl }, abortSignal)
			const key = process.stdin.isTTY ? '' : (await text(process.stdin)).trim()
			if (key.length > 0) await home.credentials.set(providerCredential(checked), key, abortSignal)
			else if ((await home.credentials.get(providerCredential(checked), abortSignal)) === undefined)
				console.error(`Set its API key with: mesh-flow provider key ${checked} < key.txt`)
		})

	provider
		.command('key')
		.description("Sets a provider's API key, read from stdin.")
		.argument('<name>')
		.action(async (name: string) => {
			const abortSignal = signal()
			const home = await gateway(abortSignal)
			if (!(await home.providers.list(abortSignal)).some((known) => known.name === name))
				throw new Error(`There is no provider ${name}. Add it with \`mesh-flow provider add\`.`)
			const key = (await text(process.stdin)).trim()
			if (key.length === 0) throw new Error('No key on stdin. Pipe one in.')
			await home.credentials.set(providerCredential(name), key, abortSignal)
		})

	provider
		.command('list')
		.description('Lists the providers in the order models are looked up, and whether each has a key.')
		.action(async () => {
			const abortSignal = signal()
			const home = await gateway(abortSignal)
			const keys = new Set(await home.credentials.names(abortSignal))
			for (const known of await home.providers.list(abortSignal)) {
				const key = keys.has(providerCredential(known.name)) ? 'key set' : 'no key'
				console.log(`${known.name}  ${known.kind}  ${key}${known.baseUrl === undefined ? '' : `  ${known.baseUrl}`}`)
			}
		})

	provider
		.command('order')
		.description('Puts the providers in this order. Name every provider once.')
		.argument('<names...>')
		.action(async (names: string[]) => {
			const abortSignal = signal()
			await (await gateway(abortSignal)).providers.order(names, abortSignal)
		})

	provider
		.command('remove')
		.description('Removes a provider and its key.')
		.argument('<name>')
		.action(async (name: string) => {
			const abortSignal = signal()
			const home = await gateway(abortSignal)
			const removed = await home.providers.remove(name, abortSignal)
			await home.credentials.remove(providerCredential(name), abortSignal)
			if (!removed) throw new Error(`There is no provider ${name}.`)
		})

	provider
		.command('kinds')
		.description('Lists the kinds of provider the gateway can send model calls to, with how many models each offers.')
		.action(() => {
			for (const known of knownKinds()) console.log(`${known.kind}  ${String(known.models)} models`)
		})
}
