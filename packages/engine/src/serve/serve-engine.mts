import { mkdir } from 'node:fs/promises'
import { createServer, type RequestListener, type Server } from 'node:http'
import path from 'node:path'
import { getRequestListener } from '@hono/node-server'
import type { SandboxBackend } from '@mesh-flow/sandbox'
import { controlApi } from '../control/control-api.mts'
import { controlSocketPath, listenOnControlSocket } from '../control/control-socket.mts'
import { Engine, type CloseDeadlines } from '../engine/engine.mts'
import type { SandboxLayout } from '../engine/sandbox-layout.mts'
import { messageOf } from '../errors.mts'
import { openRepositoryStore } from '../repositories/repository-store.mts'
import { openRunStore } from '../runs/run-store.mts'
import { openDescriptionCache } from '../triggers/description-cache.mts'
import { watchRepositories } from '../triggers/repository-watch.mts'
import { createScheduler } from '../triggers/scheduler.mts'
import { webhookApi } from '../triggers/webhook-api.mts'
import { openWebhookSecrets, webhookSecretsFile } from '../triggers/webhook-secrets.mts'
import { lockHome } from './home-lock.mts'

/** The address the webhook port listens on unless another is given: this machine only. */
export const defaultWebhookHost = '127.0.0.1'

/** How long each step of closing may take when serving webhooks fails at the start. */
const closeStepMs = 10_000

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
	/**
	 * Where to take webhook deliveries, over plain HTTP. Without it, webhooks aren't served. Put a
	 * tunnel or a reverse proxy with TLS in front of it to reach it from outside.
	 */
	readonly webhooks?: { readonly port: number; readonly host?: string }
	/** How often the registered repositories are described again, for their webhooks and schedules. Default: a minute. */
	readonly repositoryRefreshMs?: number
	/** Bounds starting up: taking the socket and reconciling. */
	readonly abortSignal: AbortSignal
}

/** An engine that serves its control API. */
export interface ServedEngine {
	readonly engine: Engine
	readonly socketPath: string
	/** Where webhook deliveries go, such as `http://127.0.0.1:8787`, when webhooks are served. */
	readonly webhookUrl?: string
	/** Stops serving, closes the engine and releases the home's lock. Calling it again waits for the same close. */
	close(deadlines: CloseDeadlines): Promise<void>
}

/**
 * Starts an engine on a home directory and serves its control API on the home's socket. The
 * home's lock comes first: it's what keeps a second engine from reconciling away the first one's
 * sandboxes.
 */
export async function serveEngine(options: ServeEngineOptions): Promise<ServedEngine> {
	await mkdir(options.home, { recursive: true, mode: 0o700 })
	let listener: RequestListener = answerStarting
	const server = createServer((request, response) => {
		listener(request, response)
	})
	const socketPath = controlSocketPath(options.home)
	const log = options.log ?? (() => undefined)
	const unlock = await lockHome(options.home, socketPath, log, options.abortSignal)
	try {
		options.abortSignal.throwIfAborted()
		await listenOnControlSocket(server, socketPath)
	} catch (error) {
		await unlock()
		throw error
	}

	let engine: Engine
	try {
		engine = await Engine.open(
			{
				backend: options.backend,
				store: openRunStore(path.join(options.home, 'runs')),
				descriptions: openDescriptionCache(path.join(options.home, 'descriptions')),
				...(options.layout ? { layout: options.layout } : {}),
				log,
			},
			options.abortSignal,
		)
	} catch (error) {
		await closeServer(server)
		await unlock()
		throw error
	}
	const repositories = openRepositoryStore(path.join(options.home, 'repositories.json'))
	const scheduler = createScheduler({ engine, log })
	const watch = watchRepositories({
		engine,
		repositories,
		log,
		refreshed: (described) => {
			scheduler.update(described)
		},
		...(options.repositoryRefreshMs === undefined ? {} : { refreshMs: options.repositoryRefreshMs }),
	})
	const changed = () => void watch.refresh()
	const stopTriggers = async (deadlineSignal: AbortSignal) => {
		await watch.close(deadlineSignal)
		scheduler.close()
	}
	const api = getRequestListener(controlApi(engine, { store: repositories, changed }).fetch)
	listener = (request, response) => {
		void api(request, response)
	}

	let webhooks: { server: Server; url: string } | undefined
	if (options.webhooks) {
		const secrets = openWebhookSecrets(webhookSecretsFile(options.home))
		const ingress = getRequestListener(webhookApi({ engine, described: watch.described, secrets, log }).fetch)
		const webhookServer = createServer((request, response) => {
			void ingress(request, response)
		})
		try {
			webhooks = { server: webhookServer, url: await listenOnPort(webhookServer, options.webhooks.port, options.webhooks.host) }
		} catch (error) {
			await stopTriggers(AbortSignal.timeout(closeStepMs))
			await closeServer(server)
			await engine.close({ pause: AbortSignal.timeout(closeStepMs), backend: AbortSignal.timeout(closeStepMs) })
			await unlock()
			throw error
		}
	}

	let closing: Promise<void> | undefined
	const close = async (deadlines: CloseDeadlines) => {
		try {
			await Promise.all([closeServer(server), webhooks ? closeServer(webhooks.server) : undefined])
			await stopTriggers(deadlines.pause)
			await engine.close(deadlines)
		} finally {
			// Reported, not thrown: an error closing the engine is the one to see.
			await unlock().catch((error: unknown) => {
				log(`Releasing the lock on ${options.home} failed: ${messageOf(error)}`)
			})
		}
	}
	return {
		engine,
		socketPath,
		...(webhooks ? { webhookUrl: webhooks.url } : {}),
		close(deadlines) {
			closing ??= close(deadlines)
			return closing
		},
	}
}

/** Listens on a TCP port, {@link defaultWebhookHost} unless another host is given, and returns the URL. */
function listenOnPort(server: Server, port: number, host = defaultWebhookHost): Promise<string> {
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, host, () => {
			server.off('error', reject)
			const address = server.address()
			if (address === null || typeof address === 'string') {
				reject(new Error('The webhook server has no TCP address.'))
				return
			}
			const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address
			resolve(`http://${shown}:${String(address.port)}`)
		})
	})
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
