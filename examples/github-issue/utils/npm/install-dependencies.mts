/**
 * Installs a checkout's npm dependencies before the developer starts, so it can run the tests
 * from its first step. Making sure the dependencies are there is the workflow's job, not the
 * agent's: the agent may still add or change dependencies with npm itself. The sandbox reaches the
 * npm registry and nothing else; see main.mts.
 */
import { execFile } from 'node:child_process'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { durationMs, toPrompt, type WaitSpec } from '@mesh-flow/core'
import type { github } from '@mesh-flow/github'

const execFileAsync = promisify(execFile)

/** How long an install may take when {@link InstallOptions.timeout} is left out. */
const defaultTimeout: WaitSpec = { hours: 1 }

const msPerSecond = 1_000
const msPerHour = 60 * 60 * msPerSecond

/** The longest timer Node keeps, about 24.8 days: a longer one fires at once. */
const maxTimerMs = 2 ** 31 - 1

/** npm writes more than execFile's 1 MiB default on a large install, which would count as a failure. */
const maxOutputBytes = 16 * 1024 * 1024

/**
 * Where a failed install's output goes, one file per repository. The prompt names the file rather
 * than holding the output, which has timestamps in it: the prompt stays the same on a rerun, so the
 * developer's loop resumes.
 */
const installLogDirectory = '/var/tmp/install-dependencies'

/** How the install went, and in a prompt, a sentence that says so. */
export interface InstallResult {
	readonly state: 'installed' | 'nothing to install' | 'failed' | 'not handled'
	readonly detail: string
	[toPrompt](): string
}

/** How {@link installDependencies} runs. */
export interface InstallOptions {
	/** Aborts the install: the run's signal. */
	readonly abortSignal: AbortSignal
	/**
	 * Gives up after this long and reports the install as failed, for a lifecycle script that hangs,
	 * such as one waiting for input. An hour when left out, and at most 596 hours (about 24.8 days),
	 * or it throws; `'indefinite'` sets no limit.
	 */
	readonly timeout?: WaitSpec | 'indefinite'
}

/** Lets corepack fetch pnpm from the npm registry without asking first. */
const corepackEnv = { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }

/** The command for each lockfile, in the order they're looked for. */
const installers = [
	{ lockfile: 'package-lock.json', command: ['npm', 'ci', '--no-audit', '--no-fund'], env: {} },
	{ lockfile: 'pnpm-lock.yaml', command: ['corepack', 'pnpm', 'install', '--frozen-lockfile'], env: corepackEnv },
] as const

/** Without a lockfile: install, but don't write one into the checkout. */
const withoutLockfile = { command: ['npm', 'install', '--no-package-lock', '--no-audit', '--no-fund'], env: {} } as const

/** Lockfiles of package managers this doesn't run: installing with npm instead would ignore them. */
const notHandled = ['yarn.lock', 'bun.lock', 'bun.lockb'] as const

/**
 * Installs as the checkout's lockfile says: `npm ci` for package-lock.json, pnpm for
 * pnpm-lock.yaml, and `npm install` without writing a lockfile when there is none. A failed install
 * isn't the run's end, since a broken lockfile may be what the issue is about: the result says
 * where npm's output is. The checkout is expected to ignore `node_modules`, since `github.push`
 * commits every change.
 *
 * ```ts
 * const dependencies = await installDependencies(repository, { abortSignal, timeout: { minutes: 10 } })
 * await developer.loop`Fix ${issue} in ${repository}. ${dependencies}`
 * ```
 */
export async function installDependencies(repository: github.Repository, options: InstallOptions): Promise<InstallResult> {
	const limitMs = installLimitMs(options.timeout ?? defaultTimeout)
	const { directory } = repository
	if (!(await exists(directory, 'package.json')))
		return result('nothing to install', `${directory} has no package.json, so it has no npm dependencies.`)
	const unhandled = await firstPresent(directory, notHandled)
	if (unhandled !== undefined)
		return result(
			'not handled',
			`${directory} has a ${unhandled}, which this sandbox can't install from, so its dependencies aren't installed.`,
		)
	const lockfile = await firstPresent(
		directory,
		installers.map((installer) => installer.lockfile),
	)
	const { command, env } = installers.find((installer) => installer.lockfile === lockfile) ?? withoutLockfile
	const [program, ...args] = command
	// The timer runs inside the sandbox, whose clock can jump across a pause; that's fine, since the
	// engine aborts the run before it pauses.
	const installTimeouts = limitMs === undefined ? [] : [AbortSignal.timeout(limitMs)]
	try {
		await execFileAsync(program, args, {
			cwd: directory,
			// Stops npm itself; a process a lifecycle script started in the background keeps running.
			signal: AbortSignal.any([options.abortSignal, ...installTimeouts]),
			maxBuffer: maxOutputBytes,
			env: { ...process.env, ...env },
		})
		return result('installed', `The npm dependencies of ${directory} are installed (${command.join(' ')}).`)
	} catch (error) {
		if (options.abortSignal.aborted) throw options.abortSignal.reason
		const log = path.join(installLogDirectory, `${repository.path.replaceAll('/', '_')}.log`)
		const stopped =
			limitMs !== undefined && installTimeouts.some((signal) => signal.aborted)
				? `Stopped after ${String(limitMs / msPerSecond)} seconds.\n`
				: ''
		await mkdir(installLogDirectory, { recursive: true })
		await writeFile(log, `${stopped}${outputOf(error)}`)
		return result('failed', `Installing the npm dependencies of ${directory} failed; the output is in ${log}.`)
	}
}

/**
 * The limit in whole milliseconds, or undefined for none. Throws for a timeout Node can't keep, the
 * same for every repository, since it's the workflow's mistake rather than the install's.
 */
function installLimitMs(timeout: WaitSpec | 'indefinite'): number | undefined {
	if (timeout === 'indefinite') return undefined
	const ms = Math.ceil(durationMs(timeout))
	if (ms > maxTimerMs)
		throw new RangeError(
			`An install timeout can be at most ${String(Math.floor(maxTimerMs / msPerHour))} hours, not ${JSON.stringify(timeout)}; use 'indefinite' for no limit.`,
		)
	return ms
}

function result(state: InstallResult['state'], detail: string): InstallResult {
	return Object.freeze({ state, detail, [toPrompt]: () => detail })
}

/** The first of `files` that is in `directory`. */
async function firstPresent<File extends string>(directory: string, files: readonly File[]): Promise<File | undefined> {
	for (const file of files) if (await exists(directory, file)) return file
	return undefined
}

function exists(directory: string, file: string): Promise<boolean> {
	return stat(path.join(directory, file)).then(
		() => true,
		() => false,
	)
}

/** What the command wrote, or the error itself when it wrote nothing, as when it couldn't start. */
function outputOf(error: unknown): string {
	const output = hasOutput(error) ? `${error.stdout}\n${error.stderr}`.trim() : ''
	return output === '' ? String(error) : output
}

/** A failed `execFile` carries what the command wrote. */
function hasOutput(error: unknown): error is { stdout: string; stderr: string } {
	return (
		error instanceof Error && 'stdout' in error && 'stderr' in error && typeof error.stdout === 'string' && typeof error.stderr === 'string'
	)
}
