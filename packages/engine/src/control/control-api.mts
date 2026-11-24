import { TriggerReference } from '@mesh-flow/protocol'
import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import type { AppStore, AppVersion } from '../apps/app-store.mts'
import { AppName } from '../apps/names.mts'
import type { Engine } from '../engine/engine.mts'
import { EngineError, type EngineErrorCode } from '../engine/engine-error.mts'
import { engineEventStream } from './engine-event-stream.mts'
import { runEventStream } from './run-event-stream.mts'
import type { ShownConnector } from './shown-connector.mts'

/**
 * The body of `POST /runs`: which trigger of which app, its parameters or payload, and optionally a
 * key, so a request sent again starts no second run.
 */
export const StartRunBody = z.object({
	app: AppName,
	trigger: TriggerReference,
	input: z.unknown().optional(),
	key: z.string().min(1).max(200).optional(),
})

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

/** What the control API answers for, besides the engine's runs. */
export interface ControlApiOptions {
	/** The deployed apps. Without them, there are no app routes. */
	readonly apps?: ControlApps | undefined
	/** The connectors the engine loaded, for `GET /connectors`. */
	readonly connectors?: readonly ShownConnector[] | undefined
}

/** The body of `POST /runs/:run/answers/:request`. */
export const AnswerBody = z.object({ value: z.unknown() }).refine((body) => 'value' in body, { message: 'An answer needs a value.' })

/** The HTTP status an engine error is answered with, here and wherever the engine's answers are passed on. */
export const engineErrorStatus: Record<EngineErrorCode, ContentfulStatusCode> = {
	'not-found': 404,
	conflict: 409,
	invalid: 400,
	unavailable: 503,
}

/**
 * The engine's control API, which the CLI talks to over the engine's local socket:
 *
 * | Route | Does |
 * |---|---|
 * | `GET /runs` | every run record |
 * | `POST /runs` | starts a run through a trigger: `{ app, trigger: { kind, id }, input }` |
 * | `GET /runs/:run` | one run record |
 * | `GET /runs/:run/events` | the run's event tree so far; asked for as `text/event-stream`, server-sent events: `run` with the record and `run-event` with each event, numbered for `Last-Event-ID`, first all of them and then each change, and `sign-in` as below |
 * | `POST /runs/:run/answers/:request` | answers an input request: `{ value }` |
 * | `POST /runs/:run/stop`, `/resume`, `/restart` | as the engine's methods of those names |
 * | `GET /events` | server-sent events: `run` with `{ id }` after each change to a run, `sign-in` with `{ connector }` after each change to a sign-in, and a `heartbeat` every `streamHeartbeat` |
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
export function controlApi(engine: Engine, { apps, connectors = [] }: ControlApiOptions = {}): Hono {
	const api = new Hono()

	api.get('/runs', (context) => context.json(engine.list()))
	api.post('/runs', async (context) => {
		const { app, trigger, input, key } = StartRunBody.parse(await context.req.json())
		return context.json(await engine.startRun({ app, trigger, input, key, abortSignal: context.req.raw.signal }), 201)
	})
	api.get('/runs/:run', (context) => context.json(engine.get(context.req.param('run'))))
	const followRun = runEventStream(engine)
	api.get('/runs/:run/events', async (context) =>
		context.req.header('accept')?.includes('text/event-stream') === true
			? followRun(context, context.req.param('run'))
			: context.json(await engine.events(context.req.param('run'))),
	)
	api.post('/runs/:run/answers/:request', async (context) => {
		const { value } = AnswerBody.parse(await context.req.json())
		return context.json(await engine.answer(context.req.param('run'), context.req.param('request'), value, context.req.raw.signal))
	})
	api.post('/runs/:run/stop', async (context) => context.json(await engine.stop(context.req.param('run'), context.req.raw.signal)))
	api.post('/runs/:run/resume', async (context) => context.json(await engine.resume(context.req.param('run'), context.req.raw.signal)))
	api.post('/runs/:run/restart', async (context) => context.json(await engine.restart(context.req.param('run'), context.req.raw.signal)))
	api.get('/events', engineEventStream(engine))
	api.get('/connectors', (context) => context.json(connectors))
	api.get('/sign-ins', (context) => context.json(engine.signIns()))
	api.post('/sign-ins/:connector', async (context) => {
		const connector = context.req.param('connector')
		await engine.waitForSignIn(connector, context.req.raw.signal)
		return context.json({ signedIn: connector })
	})

	if (apps !== undefined) {
		const { store, changed } = apps
		api.get('/apps', (context) => context.json(store.list().map(shownApp)))
		api.get('/apps/:name/missing', async (context) => {
			const name = context.req.param('name')
			const deployed = store.current(name)
			if (deployed === undefined) throw new EngineError('not-found', `There is no app ${name}.`)
			return context.json(await engine.missingSettings(deployed.manifest.description, context.req.raw.signal))
		})
		api.put('/apps/:name', async (context) => {
			const { tarball } = DeployBody.parse(await context.req.json())
			const deployed = await store.deploy(context.req.param('name'), tarball, context.req.raw.signal)
			changed()
			const missing = await engine.missingSettings(deployed.manifest.description, context.req.raw.signal)
			return context.json({ ...shownApp(deployed), missing })
		})
		api.delete('/apps/:name', async (context) => {
			const name = context.req.param('name')
			if (!AppName.safeParse(name).success) throw new EngineError('invalid', `${name} isn't an app name.`)
			if (!(await store.remove(name, context.req.raw.signal))) throw new EngineError('not-found', `There is no app ${name}.`)
			changed()
			return context.json({ removed: name })
		})
	}

	api.onError((error, context) => {
		if (error instanceof EngineError) return context.json({ error: error.message }, engineErrorStatus[error.code])
		if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: `Bad request: ${error.message}` }, 400)
		return context.json({ error: error.message }, 500)
	})
	return api
}
