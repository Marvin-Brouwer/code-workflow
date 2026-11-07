import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { Engine } from '../engine/engine.mts'
import { EngineError, type EngineErrorCode } from '../engine/engine-error.mts'

/** The body of `POST /runs`. */
export const StartRunBody = z.object({ directory: z.string().min(1), workflow: z.string().min(1) })

/** The body of `POST /runs/:run/answers/:request`. */
export const AnswerBody = z.object({ value: z.unknown() })

const statusOf: Record<EngineErrorCode, ContentfulStatusCode> = { 'not-found': 404, conflict: 409, invalid: 400 }

/**
 * The engine's control API, which the CLI talks to over the engine's local socket:
 *
 * | Route | Does |
 * |---|---|
 * | `GET /runs` | every run record |
 * | `POST /runs` | starts a run: `{ directory, workflow }` |
 * | `GET /runs/:run` | one run record |
 * | `GET /runs/:run/events` | the run's event tree so far |
 * | `POST /runs/:run/answers/:request` | answers an input request: `{ value }` |
 * | `POST /runs/:run/stop`, `/resume`, `/restart` | as the engine's methods of those names |
 *
 * Errors come back as `{ error }`, with 404, 409 or 400 for what the engine refused.
 */
export function controlApi(engine: Engine): Hono {
	const app = new Hono()

	app.get('/runs', (c) => c.json(engine.list()))
	app.post('/runs', async (c) => {
		const body = StartRunBody.parse(await c.req.json())
		return c.json(await engine.startRun({ ...body, signal: c.req.raw.signal }), 201)
	})
	app.get('/runs/:run', (c) => c.json(engine.get(c.req.param('run'))))
	app.get('/runs/:run/events', async (c) => c.json(await engine.events(c.req.param('run'))))
	app.post('/runs/:run/answers/:request', async (c) => {
		const { value } = AnswerBody.parse(await c.req.json())
		return c.json(await engine.answer(c.req.param('run'), c.req.param('request'), value, c.req.raw.signal))
	})
	app.post('/runs/:run/stop', async (c) => c.json(await engine.stop(c.req.param('run'), c.req.raw.signal)))
	app.post('/runs/:run/resume', async (c) => c.json(await engine.resume(c.req.param('run'), c.req.raw.signal)))
	app.post('/runs/:run/restart', async (c) => c.json(await engine.restart(c.req.param('run'), c.req.raw.signal)))

	app.onError((error, c) => {
		if (error instanceof EngineError) return c.json({ error: error.message }, statusOf[error.code])
		if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: `Bad request: ${error.message}` }, 400)
		return c.json({ error: error.message }, 500)
	})
	return app
}
