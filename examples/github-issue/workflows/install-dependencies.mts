/**
 * Installs a checkout's npm dependencies before the developer starts, so the agent can run the
 * tests from its first step instead of being asked to install them in the prompt. The sandbox
 * reaches the npm registry and nothing else; see main.mts.
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type { github } from '@mesh-flow/github'

const run = promisify(execFile)

/** How the install went: done, nothing to install, or failed with npm's last words. */
export type Installed = { readonly state: 'installed' | 'none' } | { readonly state: 'failed'; readonly output: string }

/**
 * `npm ci` when the checkout has a lockfile, `npm install` when it only has a package.json. A
 * failed install isn't the run's end: a broken lockfile may well be what the issue is about, so the
 * developer gets npm's output instead.
 */
export async function installDependencies(repository: github.Repository, abortSignal: AbortSignal): Promise<Installed> {
	if (!(await exists(repository.directory, 'package.json'))) return { state: 'none' }
	const command = (await exists(repository.directory, 'package-lock.json')) ? 'ci' : 'install'
	try {
		await run('npm', [command, '--no-audit', '--no-fund'], { cwd: repository.directory, signal: abortSignal, maxBuffer: 16 * 1024 * 1024 })
		return { state: 'installed' }
	} catch (error) {
		if (abortSignal.aborted) throw error
		return { state: 'failed', output: lastLines(error, 40) }
	}
}

async function exists(directory: string, file: string): Promise<boolean> {
	return await stat(path.join(directory, file)).then(
		() => true,
		() => false,
	)
}

/** The end of what npm wrote, which is where it says what went wrong. */
function lastLines(error: unknown, count: number): string {
	const output = hasOutput(error) ? `${error.stdout}\n${error.stderr}`.trim() : String(error)
	return output.split('\n').slice(-count).join('\n')
}

/** A failed `execFile` carries what the command wrote. */
function hasOutput(error: unknown): error is { stdout: string; stderr: string } {
	return (
		error instanceof Error && 'stdout' in error && 'stderr' in error && typeof error.stdout === 'string' && typeof error.stderr === 'string'
	)
}
