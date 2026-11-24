import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getRequestListener } from '@hono/node-server'
import {
	connectorSettingsFileName,
	controlClient,
	controlSocketPath,
	openConnectorSettings,
	openEngineGatewayHome,
	type ServedUi,
	type ServeUi,
	type ServeUiOptions,
} from '@mesh-flow/engine'
import open from 'open'
import { newSecret } from './ui-access.mts'
import { assertBuilt, uiApp } from './ui-app.mts'

/** The address the UI listens on: this machine only. */
const loopback = '127.0.0.1'

/** The built page, in this package's `dist/app`: found from its package.json, so it's the same from the sources and from `dist`. */
export const defaultAssets = path.join(path.dirname(fileURLToPath(import.meta.resolve('@mesh-flow/ui/package.json'))), 'dist', 'app')

/**
 * Serves the UI for an engine's home on 127.0.0.1, as `mesh-flow ui` does: the page, and its API
 * over the engine's control socket and the home's settings. The address it gives has the token that
 * lets one browser in. Aborting `abortSignal` closes it, even with requests still open.
 *
 * @example
 * ```ts
 * import { serveUi } from '@mesh-flow/ui/server'
 *
 * const stopping = new AbortController()
 * const served = await serveUi({
 * 	home: '/home/me/.local/share/mesh-flow',
 * 	keychain: true,
 * 	port: 0,
 * 	open: false,
 * 	abortSignal: stopping.signal,
 * })
 * console.log(served.url)
 * ```
 */
export const serveUi: ServeUi = async (options) => serveUiFrom(defaultAssets, options)

/** {@link serveUi} with the page from `assets`, such as a test's. */
export async function serveUiFrom(assets: string, options: ServeUiOptions): Promise<ServedUi> {
	const { home, keychain, port, abortSignal } = options
	abortSignal.throwIfAborted()
	assertBuilt(assets)
	const socketPath = controlSocketPath(home)
	const token = newSecret()
	let listener: ReturnType<typeof getRequestListener> | undefined
	const server = createServer((request, response) => {
		if (listener === undefined) response.writeHead(503).end()
		else void listener(request, response)
	})
	const address = await listen(server, port)
	const app = uiApp({
		assets,
		token,
		host: address,
		socketPath,
		client: controlClient(socketPath),
		gatewayHome: (gatewayAbortSignal) => openEngineGatewayHome(home, gatewayAbortSignal, { keychain }),
		connectors: openConnectorSettings(path.join(home, connectorSettingsFileName)),
	})
	listener = getRequestListener(app.fetch)
	const closed = new Promise<void>((resolve) => {
		const close = () => {
			server.close(() => {
				resolve()
			})
			server.closeAllConnections()
		}
		if (abortSignal.aborted) close()
		else abortSignal.addEventListener('abort', close, { once: true })
	})
	const url = `http://${address}/?token=${token}`
	// The address is printed as well, so a browser that won't open leaves the UI usable.
	if (options.open) await open(url).catch(() => undefined)
	return { url, closed }
}

/** Listens on `port` of the loopback address, and resolves to `host:port`. */
function listen(server: Server, port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, loopback, () => {
			server.off('error', reject)
			const bound = server.address()
			if (bound === null || typeof bound === 'string') reject(new Error('The UI server has no TCP address.'))
			else resolve(`${loopback}:${String(bound.port)}`)
		})
	})
}
