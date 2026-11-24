import { text } from 'node:stream/consumers'
import { knownKinds, type GatewayHome } from '@mesh-flow/gateway'
import type { ModelProviderDescription } from '@mesh-flow/protocol'
import type { Command } from 'commander'
import { listProviderModels, listProviders, removeProviderKey, setProviderKey } from '../settings/providers.mts'
import { homeCommandAbortSignal } from './home-command-abort-signal.mts'

/** What the provider commands work on. */
export interface ProviderCommandsOptions {
	readonly gatewayHome: (abortSignal: AbortSignal) => Promise<GatewayHome>
	/** The providers the current app's config declares, from the running engine. */
	readonly declared: (abortSignal: AbortSignal) => Promise<readonly ModelProviderDescription[]>
}

/**
 * `mesh-flow provider ...`: the API keys of the model providers the app's config declares. The
 * providers themselves, their order and base URLs, are in the config, in git. Setting a key works on
 * the engine's home directly, so it works without a running engine, and a running one sees the
 * change at once.
 */
export function addProviderCommands(program: Command, { gatewayHome, declared }: ProviderCommandsOptions): void {
	const provider = program
		.command('provider')
		.description("The keys of the app's model providers. The providers are in the app's config; keys stay on this machine.")

	provider
		.command('list')
		.description("Lists the providers of the app's current version, in the order models are looked up, and whether each has a key.")
		.action(async () => {
			const abortSignal = homeCommandAbortSignal()
			const providers = await declared(abortSignal)
			for (const known of await listProviders(await gatewayHome(abortSignal), providers, abortSignal)) {
				const key = known.hasKey ? 'key set' : 'no key'
				console.log(`${known.name}  ${known.kind}  ${key}${known.baseUrl === undefined ? '' : `  ${known.baseUrl}`}`)
			}
		})

	provider
		.command('models')
		.description('Asks a provider, with its key, which models it offers, and says which of them agents can use.')
		.argument('<name>', "the provider's name in the app's config")
		.action(async (name: string) => {
			const abortSignal = homeCommandAbortSignal()
			const listed = await listProviderModels(await gatewayHome(abortSignal), await declared(abortSignal), name, abortSignal)
			if (listed.source === 'failed') throw new Error(listed.reason)
			if (listed.source === 'catalog') console.log(`${name} has no model list, so these are pi-ai's models of its kind.`)
			for (const model of listed.models) console.log(`${model.id}${model.usable ? '' : "  not usable: pi-ai doesn't know it"}`)
		})

	provider
		.command('key')
		.description("Sets a provider's API key, read from stdin.")
		.argument('<name>', "the provider's name in the app's config")
		.action(async (name: string) => {
			const key = (await text(process.stdin)).trim()
			if (key.length === 0) throw new Error('No key on stdin. Pipe one in.')
			// Started once the key is in, so typing it doesn't use up the time.
			const abortSignal = homeCommandAbortSignal()
			await setProviderKey(await gatewayHome(abortSignal), await declared(abortSignal), name, key, abortSignal)
		})

	provider
		.command('remove-key')
		.description("Removes a provider's API key. The provider stays in the config, and models go to the next one.")
		.argument('<name>')
		.action(async (name: string) => {
			const abortSignal = homeCommandAbortSignal()
			await removeProviderKey(await gatewayHome(abortSignal), name, abortSignal)
		})

	provider
		.command('kinds')
		.description('Lists the kinds of provider the gateway can send model calls to, with how many models each offers.')
		.action(() => {
			for (const known of knownKinds()) console.log(`${known.kind}  ${String(known.models)} models`)
		})
}
