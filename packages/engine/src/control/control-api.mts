import { TriggerRef } from '@mesh-flow/protocol'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { AppStore, AppVersion } from '../apps/app-store.mts'
import { AppName } from '../apps/names.mts'
import type { Engine } from '../engine/engine.mts'
import { changeStream } from './change-stream.mts'
import { EngineError, type EngineErrorCode } from '../engine/engine-error.mts'

/** The body of `POST /runs`: which trigger of which app, and its parameters or payload. */
export const StartRunBody = z.object({ app: AppName, trigger: TriggerRef, input: z.unknown().optional() })

/** The body of `PUT /apps/:name`: the built app, packed, on this machine. */
export const DeployBody = z.object({ tarball: z.string().min(1) })

/** The deployed apps, and what to do when they change. */
export interface ControlApps {
	readonly store: AppStore
	/** Called after an app was deployed or removed, such as to arm its schedules. */
	readonly changed: () => void
}

/** What the control API says about a deployed app. */
function shownApp({ name, version, manifest }: AppVersion) {
	return { name, version, manifest }
}

/** A connector the engine loaded, as the control API shows it: its name, its package, and whether it signs in. */
export const ShownConnector = z.object({ name: z.string(), package: z.string(), signsIn: z.boolean() })
export type ShownConnector = z.infer<typeof ShownConnector>

/** The body of `POST /runs/:run/answers/:request`. */
export const AnswerBody = z.object({ value: z.unknown() }).refine((body) => 'value' in body, { message: 'An answer needs a value.' })

const statusOf: Record<EngineErrorCode, ContentfulStatusCode> = { 'not-found': 404, conflict: 409, invalid: 400, unavailable: 503 }

/**
 * The engine's control API, which the CLI talks to over the engine's local socket:
 *
 * | Route | Does |
 * |---|---|
 * | `GET /runs` | every run record |
 * | `POST /runs` | starts a run through a trigger: `{ app, trigger: { kind, id }, input }` |
 * | `GET /runs/:run` | one run record |
 * | `GET /runs/:run/events` | the run's event tree so far |
 * | `POST /runs/:run/answers/:request` | answers an input request: `{ value }` |
 * | `POST /runs/:run/stop`, `/resume`, `/restart` | as the engine's methods of those names |
 * | `GET /changes` | server-sent events: `run` with `{ id }` after each change to a run, and a `heartbeat` every 15 seconds |
 * | `GET /connectors` | the connectors the engine loaded, and whether each signs in |
 * | `GET /sign-ins` | the sign-ins under way, with where to sign in |
 * | `POST /sign-ins/:connector` | waits until the user signed in to the connector, joining the sign-in runs wait for |
 * | `GET /apps` | every deployed app's current version and what it declares |
 * | `GET /apps/:name/missing` | the settings the app's current version still needs before it can run |
 * | `PUT /apps/:name` | deploys a built app as the new current version: `{ tarball }`; answers with the settings it still needs in `missing` |
 * | `DELETE /apps/:name` | removes an app; runs on it keep their copy |
 *
 * Errors come back as `{ error }`, with 404, 409 or 400 for what the engine refused.
 */
export function controlApi(engine: Engine, apps?: ControlApps, connectors: readonly ShownConnector[] = []): Hono {
	const api = new Hono()

	api.get('/runs', (c) => c.json(engine.list()))
	api.post('/runs', async (c) => {
		const { app, trigger, input } = StartRunBody.parse(await c.req.json())
		return c.json(await engine.startRun({ app, trigger, input, abortSignal: c.req.raw.signal }), 201)
	})
	api.get('/runs/:run', (c) => c.json(engine.get(c.req.param('run'))))
	api.get('/runs/:run/events', async (c) => c.json(await engine.events(c.req.param('run'))))
	api.post('/runs/:run/answers/:request', async (c) => {
		const { value } = AnswerBody.parse(await c.req.json())
		return c.json(await engine.answer(c.req.param('run'), c.req.param('request'), value, c.req.raw.signal))
	})
	api.post('/runs/:run/stop', async (c) => c.json(await engine.stop(c.req.param('run'), c.req.raw.signal)))
	api.post('/runs/:run/resume', async (c) => c.json(await engine.resume(c.req.param('run'), c.req.raw.signal)))
	api.post('/runs/:run/restart', async (c) => c.json(await engine.restart(c.req.param('run'), c.req.raw.signal)))
	api.get('/changes', changeStream(engine))
	api.get('/connectors', (c) => c.json(connectors))
	api.get('/sign-ins', (c) => c.json(engine.signIns()))
	api.post('/sign-ins/:connector', async (c) => {
		const connector = c.req.param('connector')
		await engine.waitForSignIn(connector, c.req.raw.signal)
		return c.json({ signedIn: connector })
	})

	if (apps !== undefined) {
		const { store, changed } = apps
		api.get('/apps', (c) => c.json(store.list().map(shownApp)))
		api.get('/apps/:name/missing', async (c) => {
			const name = c.req.param('name')
			const deployed = store.current(name)
			if (deployed === undefined) throw new EngineError('not-found', `There is no app ${name}.`)
			return c.json(await engine.missingSettings(deployed.manifest.description, c.req.raw.signal))
		})
		api.put('/apps/:name', async (c) => {
			const { tarball } = DeployBody.parse(await c.req.json())
			const deployed = await store.deploy(c.req.param('name'), tarball, c.req.raw.signal)
			changed()
			const missing = await engine.missingSettings(deployed.manifest.description, c.req.raw.signal)
			return c.json({ ...shownApp(deployed), missing })
		})
		api.delete('/apps/:name', async (c) => {
			const name = c.req.param('name')
			if (!AppName.safeParse(name).success) throw new EngineError('invalid', `${name} isn't an app name.`)
			if (!(await store.remove(name, c.req.raw.signal))) throw new EngineError('not-found', `There is no app ${name}.`)
			changed()
			return c.json({ removed: name })
		})
	}

	api.onError((error, c) => {
		if (error instanceof EngineError) return c.json({ error: error.message }, statusOf[error.code])
		if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: `Bad request: ${error.message}` }, 400)
		return c.json({ error: error.message }, 500)
	})
	return api
}
