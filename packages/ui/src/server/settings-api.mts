import {
	listProviderModels,
	listProviders,
	removeProviderKey,
	setProviderKey,
	type ConnectorSettings,
	type ControlClient,
} from '@mesh-flow/engine'
import { CredentialName, isProviderCredential, providerKeyRefusal, type GatewayHome } from '@mesh-flow/gateway'
import { Hono } from 'hono'
import { z } from 'zod'
import { jsonBody, pathParameters } from './checked-request.mts'

/** A pasted secret without the spaces or line break around it, as the CLI reads one from stdin. */
const Secret = z.string().trim()
const KeyBody = z.object({ key: Secret.min(1) })
const SecretBody = z.object({ value: Secret.min(1) })
const CredentialRoute = z.object({ name: CredentialName })

/** What the settings work on: the engine home's files, as the CLI's commands do, and the running engine for the app. */
export interface SettingsApiOptions {
	readonly gatewayHome: (abortSignal: AbortSignal) => Promise<GatewayHome>
	/** The running engine, which has the app whose config declares the providers. */
	readonly client: ControlClient
	readonly connectors: ConnectorSettings
}

/**
 * The settings: the keys of the app's providers, credentials and connectors. Through the same
 * functions as `mesh-flow provider` and `mesh-flow credential`, on the home's files, so a running
 * engine sees a change at once. Secrets go in and never come out. Only the providers and their
 * models need the running engine, since the app's config declares them. A provider's models are
 * asked of the provider itself, with its key.
 */
export function settingsApi({ gatewayHome, client, connectors }: SettingsApiOptions): Hono {
	const api = new Hono()
	/** The providers the deployed app's config declares. */
	const declaredProviders = async (abortSignal: AbortSignal) => (await client.app(abortSignal))?.manifest.description.providers ?? []
	api.get('/providers', async (context) => {
		const abortSignal = context.req.raw.signal
		return context.json(await listProviders(await gatewayHome(abortSignal), await declaredProviders(abortSignal), abortSignal))
	})
	api.get('/providers/:name/models', async (context) => {
		const abortSignal = context.req.raw.signal
		const declared = await declaredProviders(abortSignal)
		return context.json(await listProviderModels(await gatewayHome(abortSignal), declared, context.req.param('name'), abortSignal))
	})
	api.put('/providers/:name/key', jsonBody(KeyBody), async (context) => {
		const abortSignal = context.req.raw.signal
		const { key } = context.req.valid('json')
		const declared = await declaredProviders(abortSignal)
		await setProviderKey(await gatewayHome(abortSignal), declared, context.req.param('name'), key, abortSignal)
		return context.body(null, 204)
	})
	api.delete('/providers/:name/key', async (context) => {
		const abortSignal = context.req.raw.signal
		await removeProviderKey(await gatewayHome(abortSignal), context.req.param('name'), abortSignal)
		return context.body(null, 204)
	})
	api.get('/credentials', async (context) =>
		context.json(await (await gatewayHome(context.req.raw.signal)).credentials.names(context.req.raw.signal)),
	)
	api.put('/credentials/:name{.+}', pathParameters(CredentialRoute), jsonBody(SecretBody), async (context) => {
		const { name } = context.req.valid('param')
		const { value } = context.req.valid('json')
		if (isProviderCredential(name)) return context.json({ error: providerKeyRefusal(name) }, 400)
		await (await gatewayHome(context.req.raw.signal)).credentials.set(name, value, context.req.raw.signal)
		return context.body(null, 204)
	})
	api.delete('/credentials/:name{.+}', pathParameters(CredentialRoute), async (context) => {
		const { name } = context.req.valid('param')
		const removed = await (await gatewayHome(context.req.raw.signal)).credentials.remove(name, context.req.raw.signal)
		return removed ? context.body(null, 204) : context.json({ error: `There is no credential ${name}.` }, 404)
	})
	api.get('/connectors', async (context) => context.json(await connectors.list(context.req.raw.signal)))
	return api
}
