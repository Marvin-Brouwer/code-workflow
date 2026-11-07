import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { connect, type Server } from 'node:net'
import path from 'node:path'
import { hasErrorCode } from '../error-code.mts'

/**
 * Where the engine for a home directory listens: a Unix socket in it, or a named pipe on Windows.
 * Only the user who owns the directory can reach the socket.
 */
export function controlSocketPath(home: string): string {
	if (process.platform === 'win32') {
		const hash = createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16)
		return `\\\\.\\pipe\\mesh-flow-${hash}`
	}
	return path.join(home, 'engine.sock')
}

/**
 * Listens on the control socket, and so makes sure only one engine runs per home directory. A
 * socket left behind by an engine that died is replaced; one an engine still answers on is an
 * error.
 */
export async function listenOnControlSocket(server: Server, socketPath: string): Promise<void> {
	try {
		await listen(server, socketPath)
	} catch (error) {
		if (!hasErrorCode(error, 'EADDRINUSE')) throw error
		if (await answers(socketPath)) throw new Error(`An engine is already running on ${socketPath}.`, { cause: error })
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

function answers(socketPath: string): Promise<boolean> {
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
