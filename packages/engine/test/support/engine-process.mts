import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { onTestFinished } from 'vitest'

const script = path.join(import.meta.dirname, 'serve-on-host.mts')
const loader = path.join(import.meta.dirname, 'workspace-from-source.mts')

/** Starts {@link script} for a home directory and waits until it serves. Killed when the test ends. */
export async function startEngineProcess(home: string): Promise<ChildProcess> {
	const child = spawn(process.execPath, ['--no-warnings', '--import', loader, script, home], {
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	onTestFinished(() => {
		child.kill('SIGKILL')
	})
	let output = ''
	await new Promise<void>((resolve, reject) => {
		child.stdout.on('data', (chunk: Buffer) => {
			output += chunk.toString()
			if (output.includes('ready')) resolve()
		})
		child.stderr.on('data', (chunk: Buffer) => {
			output += chunk.toString()
		})
		child.once('exit', (code) => {
			reject(new Error(`The engine exited with ${String(code)} before it was ready:\n${output}`))
		})
	})
	return child
}

/** Waits until a process has exited and returns its exit code, or the signal that ended it. */
export function exitOf(child: ChildProcess): Promise<number | NodeJS.Signals | null> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode ?? child.signalCode)
	return new Promise((resolve) => {
		child.once('exit', (code, signal) => {
			resolve(code ?? signal)
		})
	})
}
