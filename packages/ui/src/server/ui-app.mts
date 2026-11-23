import { existsSync } from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import {
	ControlError,
	EngineError,
	engineAnswers,
	type ConnectorSettings,
	type ControlClient,
	type EngineErrorCode,
} from '@mesh-flow/engine'
import type { GatewayHome } from '@mesh-flow/gateway'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { runsApi } from './runs-api.mts'
import { settingsApi } from './settings-api.mts'
import { uiAccess } from './ui-access.mts'

/** What the UI's app serves from. */
export interface UiAppOptions {
	/** The built page: `index.html` and its assets. */
	readonly assets: string
	readonly token: string
	/** The address it listens on, such as `127.0.0.1:4800`, which every request's `Host` has to name. */
	readonly host: string
	/** The engine's control socket. */
	readonly socketPath: string
	readonly client: ControlClient
	readonly gatewayHome: (abortSignal: AbortSignal) => Promise<GatewayHome>
	readonly connectors: ConnectorSettings
}

const statusOf: Record<EngineErrorCode, ContentfulStatusCode> = { 'not-found': 404, conflict: 409, invalid: 400, unavailable: 503 }

/**
 * The UI as one Hono app: access first, then `/api/engine` (runs, apps and sign-ins, from the
 * running engine), `/api/settings` (on the home's files) and the page itself, with every other
 * path answered by `index.html` so the page's own router picks it up.
 */
export function uiApp(options: UiAppOptions): Hono {
	const index = path.join(options.assets, 'index.html')
	if (!existsSync(index)) throw new Error(`The UI isn't built: there is no ${index}. Build it with \`pnpm --filter @mesh-flow/ui build\`.`)
	const app = new Hono()
	app.use(uiAccess({ token: options.token, host: options.host }))
	app.get('/api/engine/status', async (context) => context.json({ running: await engineAnswers(options.socketPath) }))
	app.route('/api/engine', runsApi(options.client))
	app.route('/api/settings', settingsApi(options))
	app.all('/api/*', (context) => context.json({ error: `There is no ${context.req.method} ${context.req.path}.` }, 404))
	app.use(serveStatic({ root: options.assets }))
	app.get('*', serveStatic({ root: options.assets, path: 'index.html' }))
	app.onError((error, context) => {
		if (error instanceof ControlError)
			return context.json({ error: error.message }, error.status === undefined ? 503 : toStatus(error.status))
		if (error instanceof EngineError) return context.json({ error: error.message }, statusOf[error.code])
		if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: `Bad request: ${error.message}` }, 400)
		return context.json({ error: error.message }, 500)
	})
	return app
}

/** An engine's answer as this API's: the same status, when it is one Hono can send with a body. */
function toStatus(status: number): ContentfulStatusCode {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the engine answered with it, so it's an HTTP status
	return status >= 400 && status < 600 ? (status as ContentfulStatusCode) : 502
}
