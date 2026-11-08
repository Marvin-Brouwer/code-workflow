import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { connect, type Server } from 'node:net'
import path from 'node:path'
import { hasErrorCode } from '../errors.mts'

/**
 * Where the engine for a home directory listens: a Unix socket in it, or a named pipe on Windows.
 * Only the user who owns the directory can reach the socket. The pipe has Windows' default
 * security, so it isn't limited to one user yet.
 */
export function controlSocketPath(home: string): string {
	if (process.platform === 'win32') {
		const hash = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16)
		return `\\\\.\\pipe\\mesh-flow-${hash}`
	}
	return path.join(home, 'engine.sock')
}

/**
 * Listens on the control socket. A socket left behind by an engine that died is replaced; one an
 * engine still answers on is an error. The home's lock, taken before, is what keeps two engines
 * from racing for it.
 */
export async function listenOnControlSocket(server: Server, socketPath: string): Promise<void> {
	try {
		await listen(server, socketPath)
	} catch (error) {
		if (!hasErrorCode(error, 'EADDRINUSE')) throw error
		if (await engineAnswers(socketPath)) throw new Error(`An engine is already running on ${socketPath}.`, { cause: error })
		await rm(socketPath, { force: true })
		await listen(server, socketPath)
	}
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const fail = (error: Error) => {
			reject(error)
		}
		server.once('error', fail)
		server.listen(socketPath, () => {
			server.off('error', fail)
			resolve()
		})
	})
}

/** Whether something accepts connections on the control socket. */
export function engineAnswers(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(socketPath)
		socket.once('connect', () => {
			socket.destroy()
			resolve(true)
		})
		socket.once('error', () => {
			resolve(false)
		})
	})
}
