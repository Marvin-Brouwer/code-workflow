import { execFile } from 'node:child_process'

/** Runs a program on the host and returns its stdout. Throws with stderr when it fails. */
export function runOnHost(program: string, args: readonly string[], cwd: string, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(program, args, { cwd, signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${program} ${args.join(' ')} failed: ${stderr.trim() || error.message}`, { cause: error }))
			else resolve(stdout)
		})
	})
}
