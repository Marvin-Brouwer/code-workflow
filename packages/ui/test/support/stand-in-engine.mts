import { createServer, type Server } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { controlSocketPath, engineEventStream, openEngineGatewayHome, RunRecord, runEventStream } from '@mesh-flow/engine'
import { Hono } from 'hono'
import { onTestFinished } from 'vitest'
import { z } from 'zod'

/**
 * The app the stand-in has deployed: one workflow that needs a GitHub token, started by two buttons,
 * a webhook without its secret, and a schedule.
 */
export const standInApp = 'dice'

/** The cron of the stand-in app's schedule. */
export const standInSchedule = '0 3 * * *'

const builtAt = '2026-11-23T08:00:00.000Z'

const app = {
	name: standInApp,
	version: 'v1',
	manifest: {
		entry: 'main.mjs',
		platform: { os: 'linux', cpu: 'x64' },
		builtAt,
		description: {
			sandbox: { image: 'node:26', cpus: 1, memoryMb: 512, registries: [] },
			workflows: [
				{
					name: 'fix-issue',
					parameters: {
						type: 'object',
						properties: { issue: { type: 'integer', description: 'The issue to fix' } },
						required: ['issue'],
					},
				},
			],
			triggers: [
				{ kind: 'user', id: 'fix-issue', workflow: 'fix-issue' },
				{ kind: 'user', id: 'retry-issue', workflow: 'fix-issue' },
				{
					kind: 'webhook',
					id: 'issue-opened',
					workflow: 'fix-issue',
					payload: { type: 'object' },
					signature: { scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' },
				},
				{ kind: 'schedule', id: 'nightly', workflow: 'fix-issue', cron: standInSchedule },
			],
			tools: [],
			models: [],
		},
	},
}

interface StandInRun {
	id: string
	status: string
	pending: unknown[]
	events: { id: string; type: string; at: string; parentId?: string; [field: string]: unknown }[]
	updatedAt: string
}

/**
 * A stand-in for the engine on the home's control socket, for the UI's tests: it answers the routes
 * the UI calls, with one app whose run asks one question, and streams its changes. It reads the
 * home's credentials, as the engine does, so the wizard asks for the token until it's set.
 */
export async function standInEngine(home: string) {
	const runs = new Map<string, StandInRun>()
	const listeners = new Set<(id: string) => void>()
	const changed = (run: StandInRun) => {
		run.updatedAt = new Date().toISOString()
		for (const listener of listeners) listener(run.id)
	}
	const record = (run: StandInRun) =>
		RunRecord.parse({
			id: run.id,
			workflow: 'fix-issue',
			trigger: { kind: 'user', id: 'fix-issue' },
			app: {
				name: standInApp,
				version: 'v1',
				entry: 'main.mjs',
				sandbox: { image: 'node:26', cpus: 1, memoryMb: 512 },
				tools: [],
				registries: [],
			},
			status: run.status,
			cursor: 0,
			pending: run.pending,
			createdAt: builtAt,
			updatedAt: run.updatedAt,
		})
	const event = (run: StandInRun, type: string, parentId: string | undefined, fields: Record<string, unknown> = {}) => {
		const id = `1-${String(run.events.length + 1)}`
		run.events.push({ ...fields, id, type, at: new Date().toISOString(), ...(parentId === undefined ? {} : { parentId }) })
		return id
	}
	const found = (id: string) => {
		const run = runs.get(id)
		if (run === undefined) throw new Error(`There is no run ${id}.`)
		return run
	}

	const api = new Hono()
	api.get('/apps', (context) => context.json([app]))
	api.get('/apps/:name/missing', async (context) => {
		const gatewayHome = await openEngineGatewayHome(home, context.req.raw.signal, { keychain: false })
		const names = await gatewayHome.credentials.names(context.req.raw.signal)
		return context.json(
			names.includes('github/token')
				? []
				: [{ message: 'Set github/token: `mesh-flow credential set github/token`', fix: { kind: 'credential', name: 'github/token' } }],
		)
	})
	api.post('/runs', async (context) => {
		const { input } = z.object({ input: z.object({ issue: z.number() }) }).parse(await context.req.json())
		const run: StandInRun = {
			id: `run-${String(runs.size + 1).padStart(12, '0')}`,
			status: 'running',
			pending: [],
			events: [],
			updatedAt: builtAt,
		}
		runs.set(run.id, run)
		const root = event(run, 'workflow', undefined, { workflow: 'fix-issue' })
		const call = event(run, 'tool-call', root, { tool: 'githubIssue', from: 'code', input })
		event(run, 'tool-call-succeeded', call, { title: `Collected issue #${String(input.issue)}`, result: '{"title":"The dice roll a 7"}' })
		// What a sandbox writes can carry markup meant to run in the page: it has to show as text.
		const loop = event(run, 'loop', root, { model: 'claude-sonnet-5-5' })
		event(run, 'turn', loop, { turn: 1, text: '<script>window.injected = true</script>' })
		event(run, 'tool-call', loop, {
			tool: 'read',
			from: 'agent',
			input: { path: 'README.md' },
			failed: false,
			result: '<img src=x onerror="window.injected = true">',
		})
		event(run, 'loop-succeeded', loop)
		event(run, 'input', root, { question: 'Which die is wrong?' })
		run.pending = [{ kind: 'input', id: 'input-1', question: 'Which die is wrong?', fields: { answer: { type: 'string' } } }]
		changed(run)
		return context.json(record(run), 201)
	})
	api.get('/runs', (context) => context.json([...runs.values()].map(record)))
	api.get('/runs/:run', (context) => context.json(record(found(context.req.param('run')))))
	api.get('/runs/:run/events', (context) =>
		context.req.header('accept')?.includes('text/event-stream') === true
			? followRun(context, context.req.param('run'))
			: context.json(found(context.req.param('run')).events),
	)
	api.post('/runs/:run/answers/:request', async (context) => {
		const run = found(context.req.param('run'))
		const { value } = z.object({ value: z.object({ answer: z.string() }) }).parse(await context.req.json())
		const input = String(run.events.find(({ type }) => type === 'input')?.id)
		event(run, 'input-answered', input, { request: 'input-1' })
		event(run, 'input-succeeded', input)
		event(run, 'workflow-succeeded', '1-1', { answer: value.answer })
		run.pending = []
		run.status = 'succeeded'
		changed(run)
		return context.json(record(run))
	})
	api.get('/sign-ins', (context) => context.json([]))
	api.get('/connectors', (context) => context.json([]))
	const onRunChange = (listener: (id: string) => void, abortSignal: AbortSignal) => {
		listeners.add(listener)
		abortSignal.addEventListener(
			'abort',
			() => {
				listeners.delete(listener)
			},
			{ once: true },
		)
	}
	api.get('/events', engineEventStream({ onRunChange, onSignInChange: () => undefined }))
	const followRun = runEventStream({
		find: (id) => {
			const run = runs.get(id)
			return run === undefined ? undefined : record(run)
		},
		events: (id) => Promise.resolve(found(id).events),
		onRunChange,
		onSignInChange: () => undefined,
	})
	const listener = getRequestListener(api.fetch)
	const server: Server = createServer((incoming, outgoing) => {
		void listener(incoming, outgoing)
	})
	await new Promise<void>((resolve) => server.listen(controlSocketPath(home), resolve))
	onTestFinished(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => {
					resolve()
				})
				server.closeAllConnections()
			}),
	)
	return { runs }
}
