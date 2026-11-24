import { Readable } from 'node:stream'
import { AnswerBody, StartRunBody, type ControlClient } from '@mesh-flow/engine'
import { Hono } from 'hono'
import { jsonBody } from './checked-request.mts'

/**
 * The runs, apps and sign-ins, from the running engine over its control socket: the same calls the
 * CLI makes. Only these routes, not the whole control API, so the browser can't deploy.
 */
export function runsApi(client: ControlClient): Hono {
	const api = new Hono()
	api.get('/runs', async (context) => context.json(await client.list(context.req.raw.signal)))
	api.post('/runs', jsonBody(StartRunBody), async (context) => {
		const { app, trigger, input, key } = context.req.valid('json')
		return context.json(await client.startRun({ app, trigger, input, key, abortSignal: context.req.raw.signal }), 201)
	})
	api.get('/runs/:run', async (context) => context.json(await client.get(context.req.param('run'), context.req.raw.signal)))
	api.get('/runs/:run/events', async (context) => {
		const run = context.req.param('run')
		const abortSignal = context.req.raw.signal
		if (context.req.header('accept')?.includes('text/event-stream') !== true) return context.json(await client.events(run, abortSignal))
		return streamed(await client.followRun(run, { lastEventId: context.req.header('last-event-id'), abortSignal }))
	})
	api.post('/runs/:run/answers/:request', jsonBody(AnswerBody), async (context) => {
		const { value } = context.req.valid('json')
		return context.json(await client.answer(context.req.param('run'), context.req.param('request'), value, context.req.raw.signal))
	})
	api.post('/runs/:run/stop', async (context) => context.json(await client.stop(context.req.param('run'), context.req.raw.signal)))
	api.post('/runs/:run/resume', async (context) => context.json(await client.resume(context.req.param('run'), context.req.raw.signal)))
	api.post('/runs/:run/restart', async (context) => context.json(await client.restart(context.req.param('run'), context.req.raw.signal)))
	api.get('/events', async (context) => streamed(await client.followEngine(context.req.raw.signal)))
	api.get('/connectors', async (context) => context.json(await client.connectors(context.req.raw.signal)))
	api.get('/sign-ins', async (context) => context.json(await client.signIns(context.req.raw.signal)))
	api.post('/sign-ins/:connector', async (context) => {
		const connector = context.req.param('connector')
		await client.waitForSignIn(connector, context.req.raw.signal)
		return context.json({ signedIn: connector })
	})
	api.get('/apps', async (context) => context.json(await client.apps(context.req.raw.signal)))
	api.get('/apps/:name/missing', async (context) =>
		context.json(await client.missingSettings(context.req.param('name'), context.req.raw.signal)),
	)
	return api
}

/** The engine's server-sent events, passed on as they come. */
function streamed(events: Readable): Response {
	return new Response(Readable.toWeb(events), {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
		},
	})
}
