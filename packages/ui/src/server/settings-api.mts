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
	api.get('/provider-kinds', (c) => c.json(knownKinds()))
	api.get('/providers', async (c) => c.json(await listProviders(await gatewayHome(c.req.raw.signal), c.req.raw.signal)))
	api.put('/providers/:name', async (c) => {
		const { kind, baseUrl, key } = ProviderBody.parse(await c.req.json())
		const input = { name: c.req.param('name'), kind, baseUrl, key }
		await putProvider(await gatewayHome(c.req.raw.signal), input, c.req.raw.signal)
		return c.body(null, 204)
	})
	api.put('/providers/:name/key', async (c) => {
		const { key } = KeyBody.parse(await c.req.json())
		await setProviderKey(await gatewayHome(c.req.raw.signal), c.req.param('name'), key, c.req.raw.signal)
		return c.body(null, 204)
	})
	api.delete('/providers/:name', async (c) => {
		await removeProvider(await gatewayHome(c.req.raw.signal), c.req.param('name'), c.req.raw.signal)
		return c.body(null, 204)
	})
	api.put('/provider-order', async (c) => {
		const { names } = OrderBody.parse(await c.req.json())
		await (await gatewayHome(c.req.raw.signal)).providers.order(names, c.req.raw.signal)
		return c.body(null, 204)
	})
	api.get('/credentials', async (c) => c.json(await (await gatewayHome(c.req.raw.signal)).credentials.names(c.req.raw.signal)))
	api.put('/credentials/:name{.+}', async (c) => {
		const name = CredentialName.parse(c.req.param('name'))
		const { value } = SecretBody.parse(await c.req.json())
		await (await gatewayHome(c.req.raw.signal)).credentials.set(name, value, c.req.raw.signal)
		return c.body(null, 204)
	})
	api.delete('/credentials/:name{.+}', async (c) => {
		const name = c.req.param('name')
		const removed = await (await gatewayHome(c.req.raw.signal)).credentials.remove(name, c.req.raw.signal)
		return removed ? c.body(null, 204) : c.json({ error: `There is no credential ${name}.` }, 404)
	})
	api.get('/connectors', async (c) => c.json(await connectors.list(c.req.raw.signal)))
	return api
}
