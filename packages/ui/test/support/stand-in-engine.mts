import { createServer, type Server } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import { controlSocketPath, openEngineGatewayHome } from '@mesh-flow/engine'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { onTestFinished } from 'vitest'
import { z } from 'zod'

/** The app the stand-in has deployed: one workflow, started by a button, that needs a GitHub token. */
export const standInApp = 'dice'

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
			triggers: [{ kind: 'user', id: 'fix-issue', workflow: 'fix-issue' }],
			tools: [],
			models: [],
		},
	},
}

interface StandInRun {
	id: string
	status: string
	pending: unknown[]
	events: Record<string, unknown>[]
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
	const record = (run: StandInRun) => ({
		id: run.id,
		workflow: 'fix-issue',
		trigger: { kind: 'user', id: 'fix-issue' },
		app: { name: standInApp, version: 'v1', entry: 'main.mjs', sandbox: { image: 'node:26', cpus: 1, memoryMb: 512 } },
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
	api.get('/apps', (c) => c.json([app]))
	api.get('/apps/:name/missing', async (c) => {
		const gatewayHome = await openEngineGatewayHome(home, c.req.raw.signal, { keychain: false })
		const names = await gatewayHome.credentials.names(c.req.raw.signal)
		return c.json(
			names.includes('github/token')
				? []
				: [{ message: 'Set github/token: `mesh-flow credential set github/token`', fix: { kind: 'credential', name: 'github/token' } }],
		)
	})
	api.post('/runs', async (c) => {
		const { input } = z.object({ input: z.object({ issue: z.number() }) }).parse(await c.req.json())
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
		event(run, 'input', root, { question: 'Which die is wrong?' })
		run.pending = [{ kind: 'input', id: 'input-1', question: 'Which die is wrong?', fields: { answer: { type: 'string' } } }]
		changed(run)
		return c.json(record(run), 201)
	})
	api.get('/runs', (c) => c.json([...runs.values()].map(record)))
	api.get('/runs/:run', (c) => c.json(record(found(c.req.param('run')))))
	api.get('/runs/:run/events', (c) => c.json(found(c.req.param('run')).events))
	api.post('/runs/:run/answers/:request', async (c) => {
		const run = found(c.req.param('run'))
		const { value } = z.object({ value: z.object({ answer: z.string() }) }).parse(await c.req.json())
		const input = String(run.events.find(({ type }) => type === 'input')?.id)
		event(run, 'input-answered', input, { request: 'input-1' })
		event(run, 'input-succeeded', input)
		event(run, 'workflow-succeeded', '1-1', { answer: value.answer })
		run.pending = []
		run.status = 'succeeded'
		changed(run)
		return c.json(record(run))
	})
	api.get('/sign-ins', (c) => c.json([]))
	api.get('/connectors', (c) => c.json([]))
	api.get('/changes', (c) =>
		streamSSE(c, async (stream) => {
			const listener = (id: string) => {
				void stream.writeSSE({ event: 'run', data: JSON.stringify({ id }) })
			}
			listeners.add(listener)
			await stream.writeSSE({ event: 'ready', data: '{}' })
			await new Promise<void>((resolve) => {
				stream.onAbort(resolve)
			})
			listeners.delete(listener)
		}),
	)

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
