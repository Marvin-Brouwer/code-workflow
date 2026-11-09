import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { Engine } from '../engine/engine.mts'
import { EngineError, type EngineErrorCode } from '../engine/engine-error.mts'
import { messageOf } from '../errors.mts'
import { Repository, type RepositoryStore } from '../repositories/repository-store.mts'
import { findEntry } from '../workflow/workflow-config.mts'
import { WorkflowName } from '../workflow/workflow-name.mts'

/** The body of `POST /runs`. */
export const StartRunBody = z.object({ directory: z.string().min(1), workflow: WorkflowName, parameters: z.unknown().optional() })

/** The body of `POST /describe`. */
export const DescribeBody = z.object({ directory: z.string().min(1) })

/** The body of `PUT /repositories/:name`: where the repository is on the host. */
export const RepositoryBody = z.object({ directory: z.string().min(1) })

/** The repositories the engine serves triggers for, and what to do when they change. */
export interface ControlRepositories {
	readonly store: RepositoryStore
	/** Called after a repository was added or removed, such as to read the schedules again. */
	readonly changed: () => void
}

/** The body of `POST /runs/:run/answers/:request`. */
export const AnswerBody = z.object({ value: z.unknown() }).refine((body) => 'value' in body, { message: 'An answer needs a value.' })

const statusOf: Record<EngineErrorCode, ContentfulStatusCode> = { 'not-found': 404, conflict: 409, invalid: 400 }

/**
 * The engine's control API, which the CLI talks to over the engine's local socket:
 *
 * | Route | Does |
 * |---|---|
 * | `GET /runs` | every run record |
 * | `POST /runs` | starts a run: `{ directory, workflow, parameters? }` |
 * | `GET /runs/:run` | one run record |
 * | `GET /runs/:run/events` | the run's event tree so far |
 * | `POST /runs/:run/answers/:request` | answers an input request: `{ value }` |
 * | `POST /runs/:run/stop`, `/resume`, `/restart` | as the engine's methods of those names |
 * | `POST /describe` | what a repository's entry file declares: `{ directory }` |
 * | `GET /repositories` | the repositories the engine serves triggers for |
 * | `PUT /repositories/:name` | registers a repository: `{ directory }` |
 * | `DELETE /repositories/:name` | unregisters one |
 *
 * Errors come back as `{ error }`, with 404, 409 or 400 for what the engine refused.
 */
export function controlApi(engine: Engine, repositories?: ControlRepositories): Hono {
	const app = new Hono()

	app.get('/runs', (c) => c.json(engine.list()))
	app.post('/runs', async (c) => {
		const { directory, workflow, parameters } = StartRunBody.parse(await c.req.json())
		return c.json(await engine.startRun({ directory, workflow, input: parameters, abortSignal: c.req.raw.signal }), 201)
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

	app.post('/describe', async (c) => {
		const { directory } = DescribeBody.parse(await c.req.json())
		return c.json(await engine.describe(directory, c.req.raw.signal))
	})

	if (repositories !== undefined) {
		const { store, changed } = repositories
		app.get('/repositories', async (c) => c.json(await store.list()))
		app.put('/repositories/:name', async (c) => {
			const repository = Repository.parse({ ...RepositoryBody.parse(await c.req.json()), name: c.req.param('name') })
			await findEntry(repository.directory).catch((error: unknown) => {
				throw new EngineError('invalid', messageOf(error))
			})
			await store.add(repository)
			changed()
			return c.json(repository)
		})
		app.delete('/repositories/:name', async (c) => {
			const name = c.req.param('name')
			if (!(await store.remove(name))) throw new EngineError('not-found', `There is no repository ${name}.`)
			changed()
			return c.json({ removed: name })
		})
	}

	app.onError((error, c) => {
		if (error instanceof EngineError) return c.json({ error: error.message }, statusOf[error.code])
		if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: `Bad request: ${error.message}` }, 400)
		return c.json({ error: error.message }, 500)
	})
	return app
}
