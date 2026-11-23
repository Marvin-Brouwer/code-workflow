import { Readable } from 'node:stream'
import { AnswerBody, StartRunBody, type ControlClient } from '@mesh-flow/engine'
import { Hono } from 'hono'

/**
 * The runs, apps and sign-ins, from the running engine over its control socket: the same calls the
 * CLI makes. Only these routes, not the whole control API, so the browser can't deploy.
 */
export function runsApi(client: ControlClient): Hono {
	const api = new Hono()
	api.get('/runs', async (c) => c.json(await client.list(c.req.raw.signal)))
	api.post('/runs', async (c) => {
		const { app, trigger, input } = StartRunBody.parse(await c.req.json())
		return c.json(await client.startRun({ app, trigger, input, abortSignal: c.req.raw.signal }), 201)
	})
	api.get('/runs/:run', async (c) => c.json(await client.get(c.req.param('run'), c.req.raw.signal)))
	api.get('/runs/:run/events', async (c) => c.json(await client.events(c.req.param('run'), c.req.raw.signal)))
	api.post('/runs/:run/answers/:request', async (c) => {
		const { value } = AnswerBody.parse(await c.req.json())
		return c.json(await client.answer(c.req.param('run'), c.req.param('request'), value, c.req.raw.signal))
	})
	api.post('/runs/:run/stop', async (c) => c.json(await client.stop(c.req.param('run'), c.req.raw.signal)))
	api.post('/runs/:run/resume', async (c) => c.json(await client.resume(c.req.param('run'), c.req.raw.signal)))
	api.post('/runs/:run/restart', async (c) => c.json(await client.restart(c.req.param('run'), c.req.raw.signal)))
	api.get('/changes', async (c) => {
		const changes = await client.changes(c.req.raw.signal)
		return new Response(Readable.toWeb(changes), {
			headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
		})
	})
	api.get('/connectors', async (c) => c.json(await client.connectors(c.req.raw.signal)))
	api.get('/sign-ins', async (c) => c.json(await client.signIns(c.req.raw.signal)))
	api.post('/sign-ins/:connector', async (c) => {
		const connector = c.req.param('connector')
		await client.waitForSignIn(connector, c.req.raw.signal)
		return c.json({ signedIn: connector })
	})
	api.get('/apps', async (c) => c.json(await client.apps(c.req.raw.signal)))
	api.get('/apps/:name/missing', async (c) => c.json(await client.missingSettings(c.req.param('name'), c.req.raw.signal)))
	return api
}
