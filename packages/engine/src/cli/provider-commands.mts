import { text } from 'node:stream/consumers'
import { knownKinds, type GatewayHome } from '@mesh-flow/gateway'
import type { Command } from 'commander'
import { listProviders, putProvider, removeProvider, setProviderKey } from '../settings/providers.mts'
import { homeCommandAbortSignal } from './home-command-abort-signal.mts'

/**
 * `mesh-flow provider ...`: the user's model providers, in order, and their API keys. They work on
 * the engine's home directly, so they work without a running engine, and a running one sees the
 * change at once.
 */
export function addProviderCommands(program: Command, gatewayHome: (abortSignal: AbortSignal) => Promise<GatewayHome>): void {
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
			// Read first: the time a command may take starts once its input is in.
			const key = process.stdin.isTTY ? '' : (await text(process.stdin)).trim()
			const abortSignal = homeCommandAbortSignal()
			const home = await gatewayHome(abortSignal)
			await putProvider(home, { name, ...options, key }, abortSignal)
			if (!(await listProviders(home, abortSignal)).some((known) => known.name === name && known.hasKey))
				console.error(`Set its API key with: mesh-flow provider key ${name} < key.txt`)
		})

	provider
		.command('key')
		.description("Sets a provider's API key, read from stdin.")
		.argument('<name>')
		.action(async (name: string) => {
			const key = (await text(process.stdin)).trim()
			if (key.length === 0) throw new Error('No key on stdin. Pipe one in.')
			const abortSignal = homeCommandAbortSignal()
			await setProviderKey(await gatewayHome(abortSignal), name, key, abortSignal)
		})

	provider
		.command('list')
		.description('Lists the providers in the order models are looked up, and whether each has a key.')
		.action(async () => {
			const abortSignal = homeCommandAbortSignal()
			for (const known of await listProviders(await gatewayHome(abortSignal), abortSignal)) {
				const key = known.hasKey ? 'key set' : 'no key'
				console.log(`${known.name}  ${known.kind}  ${key}${known.baseUrl === undefined ? '' : `  ${known.baseUrl}`}`)
			}
		})

	provider
		.command('order')
		.description('Puts the providers in this order. Name every provider once.')
		.argument('<names...>')
		.action(async (names: string[]) => {
			const abortSignal = homeCommandAbortSignal()
			await (await gatewayHome(abortSignal)).providers.order(names, abortSignal)
		})

	provider
		.command('remove')
		.description('Removes a provider and its key.')
		.argument('<name>')
		.action(async (name: string) => {
			const abortSignal = homeCommandAbortSignal()
			await removeProvider(await gatewayHome(abortSignal), name, abortSignal)
		})

	provider
		.command('kinds')
		.description('Lists the kinds of provider the gateway can send model calls to, with how many models each offers.')
		.action(() => {
			for (const known of knownKinds()) console.log(`${known.kind}  ${String(known.models)} models`)
		})
}
