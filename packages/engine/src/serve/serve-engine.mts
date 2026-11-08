import { mkdir } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import path from 'node:path'
import { getRequestListener } from '@hono/node-server'
import type { SandboxBackend } from '@mesh-flow/sandbox'
import { controlApi } from '../control/control-api.mts'
import { controlSocketPath, listenOnControlSocket } from '../control/control-socket.mts'
import { Engine, type CloseDeadlines } from '../engine/engine.mts'
import type { SandboxLayout } from '../engine/sandbox-layout.mts'
import { openRunStore } from '../runs/run-store.mts'

/** What to serve an engine on. */
export interface ServeEngineOptions {
	/** The engine's own directory: run records, the control socket, backend state. */
	readonly home: string
	/** Where the runs' sandboxes are made. */
	readonly backend: SandboxBackend
	/** Where things go inside a sandbox. Default: the engine's default layout. */
	readonly layout?: SandboxLayout
	/** Where the engine reports what it did on its own. Default: nowhere. */
	readonly log?: (message: string) => void
	/** Bounds starting up: taking the socket and reconciling. */
	readonly signal: AbortSignal
}

/** An engine that serves its control API. */
export interface ServedEngine {
	readonly engine: Engine
	readonly socketPath: string
	/** Stops serving, then closes the engine. */
	close(deadlines: CloseDeadlines): Promise<void>
}

/**
 * Starts an engine on a home directory and serves its control API on the home's socket. The
 * socket comes first: it's what keeps a second engine from reconciling away the first one's
 * sandboxes.
 */
export async function serveEngine(options: ServeEngineOptions): Promise<ServedEngine> {
	await mkdir(options.home, { recursive: true, mode: 0o700 })
	let listener: RequestListener = answerStarting
	const server = createServer((request, response) => {
		listener(request, response)
	})
	const socketPath = controlSocketPath(options.home)
	await listenOnControlSocket(server, socketPath)

	let engine: Engine
	try {
		engine = await Engine.open(
			{
				backend: options.backend,
				store: openRunStore(path.join(options.home, 'runs')),
				...(options.layout ? { layout: options.layout } : {}),
				...(options.log ? { log: options.log } : {}),
			},
			options.signal,
		)
	} catch (error) {
		await closeServer(server)
		throw error
	}
	const api = getRequestListener(controlApi(engine).fetch)
	listener = (request, response) => {
		void api(request, response)
	}

	return {
		engine,
		socketPath,
		async close(deadlines) {
			await closeServer(server)
			await engine.close(deadlines)
		},
	}
}

const answerStarting: RequestListener = (_request, response) => {
	response.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"The engine is starting."}')
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => {
			resolve()
		})
		server.closeAllConnections()
	})
}
