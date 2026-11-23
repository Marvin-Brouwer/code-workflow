import { listProviders, putProvider, removeProvider, setProviderKey, type ConnectorSettings } from '@mesh-flow/engine'
import { CredentialName, knownKinds, type GatewayHome } from '@mesh-flow/gateway'
import { Hono } from 'hono'
import { z } from 'zod'

const ProviderBody = z.object({ kind: z.string(), baseUrl: z.url().optional(), key: z.string().optional() })
const KeyBody = z.object({ key: z.string().min(1) })
const OrderBody = z.object({ names: z.array(z.string()) })
const SecretBody = z.object({ value: z.string().min(1) })

/** What the settings work on: the engine home's files, as the CLI's commands do. */
export interface SettingsApiOptions {
	readonly gatewayHome: (abortSignal: AbortSignal) => Promise<GatewayHome>
	readonly connectors: ConnectorSettings
}

/**
 * The settings: providers and their keys, credentials and connectors. Through the same functions
 * as `mesh-flow provider` and `mesh-flow credential`, on the home's files, so they work without a
 * running engine, and a running one sees a change at once. Secrets go in and never come out.
 */
export function settingsApi({ gatewayHome, connectors }: SettingsApiOptions): Hono {
	const api = new Hono()
	api.get('/provider-kinds', (context) => context.json(knownKinds()))
	api.get('/providers', async (context) =>
		context.json(await listProviders(await gatewayHome(context.req.raw.signal), context.req.raw.signal)),
	)
	api.put('/providers/:name', async (context) => {
		const { kind, baseUrl, key } = ProviderBody.parse(await context.req.json())
		const input = { name: context.req.param('name'), kind, baseUrl, key }
		await putProvider(await gatewayHome(context.req.raw.signal), input, context.req.raw.signal)
		return context.body(null, 204)
	})
	api.put('/providers/:name/key', async (context) => {
		const { key } = KeyBody.parse(await context.req.json())
		await setProviderKey(await gatewayHome(context.req.raw.signal), context.req.param('name'), key, context.req.raw.signal)
		return context.body(null, 204)
	})
	api.delete('/providers/:name', async (context) => {
		await removeProvider(await gatewayHome(context.req.raw.signal), context.req.param('name'), context.req.raw.signal)
		return context.body(null, 204)
	})
	api.put('/provider-order', async (context) => {
		const { names } = OrderBody.parse(await context.req.json())
		await (await gatewayHome(context.req.raw.signal)).providers.order(names, context.req.raw.signal)
		return context.body(null, 204)
	})
	api.get('/credentials', async (context) =>
		context.json(await (await gatewayHome(context.req.raw.signal)).credentials.names(context.req.raw.signal)),
	)
	api.put('/credentials/:name{.+}', async (context) => {
		const name = CredentialName.parse(context.req.param('name'))
		const { value } = SecretBody.parse(await context.req.json())
		await (await gatewayHome(context.req.raw.signal)).credentials.set(name, value, context.req.raw.signal)
		return context.body(null, 204)
	})
	api.delete('/credentials/:name{.+}', async (context) => {
		const name = context.req.param('name')
		const removed = await (await gatewayHome(context.req.raw.signal)).credentials.remove(name, context.req.raw.signal)
		return removed ? context.body(null, 204) : context.json({ error: `There is no credential ${name}.` }, 404)
	})
	api.get('/connectors', async (context) => context.json(await connectors.list(context.req.raw.signal)))
	return api
}
