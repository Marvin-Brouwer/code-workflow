import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { messageOf } from '../errors.mts'

const execFileAsync = promisify(execFile)

/** Runs a program on the host and returns its stdout. Throws with stderr when it fails. */
export async function runOnHost(program: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<string> {
	try {
		const { stdout } = await execFileAsync(program, args, { cwd, signal, maxBuffer: 64 * 1024 * 1024 })
		return stdout
	} catch (error) {
		const stderr = error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr.trim() : ''
		throw new Error(`${program} ${args.join(' ')} failed: ${stderr || messageOf(error)}`, { cause: error })
	}
}
