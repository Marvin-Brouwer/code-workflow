/**
 * Installs a checkout's npm dependencies, so the developer can run the tests from its first step
 * instead of being asked to install them in the prompt. The sandbox reaches the npm registry and
 * nothing else; see main.mts. Called from code before the developer starts, and a tool the
 * developer can call again after changing the dependencies.
 */
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { tool, toPrompt, workspace } from '@mesh-flow/core'
import { z } from 'zod'

const execFileAsync = promisify(execFile)

/** npm writes more than execFile's 1 MiB default on a large install, which would count as a failure. */
const maxOutputBytes = 16 * 1024 * 1024

/** An install that takes longer has hung, such as a lifecycle script that waits for input. */
const installTimeoutMinutes = 10
const installTimeoutMs = installTimeoutMinutes * 60_000

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
 * where npm's output is. `node_modules` is kept out of git, so a push never commits it.
 *
 * ```ts
 * const dependencies = await installDependencies({ repository: repository.path })
 * await developer.loop`Fix ${issue} in ${repository}. ${dependencies}`
 * ```
 */
export const installDependencies = tool('installDependencies', {
	description: "Installs a repository's npm dependencies, as its lockfile says. Run it again after changing them.",
	input: z.object({ repository: z.string().describe("The repository's path in the workspace") }),
	action: async ({ repository }, { abortSignal }): Promise<InstallResult> => {
		const directory = workspace.folder(repository).location()
		if (!(await exists(directory, 'package.json')))
			return result('nothing to install', `${repository} has no package.json, so it has no npm dependencies.`)
		const unhandled = await firstPresent(directory, notHandled)
		if (unhandled !== undefined)
			return result(
				'not handled',
				`${repository} has a ${unhandled}, which this sandbox can't install from, so its dependencies aren't installed.`,
			)
		const lockfile = await firstPresent(
			directory,
			installers.map((installer) => installer.lockfile),
		)
		const { command, env } = installers.find((installer) => installer.lockfile === lockfile) ?? withoutLockfile
		const [program, ...args] = command
		await excludeFromGit(directory, 'node_modules', abortSignal)
		const installTimeout = AbortSignal.timeout(installTimeoutMs)
		try {
			await execFileAsync(program, args, {
				cwd: directory,
				signal: AbortSignal.any([abortSignal, installTimeout]),
				maxBuffer: maxOutputBytes,
				env: { ...process.env, ...env },
			})
			return result('installed', `The npm dependencies of ${repository} are installed (${command.join(' ')}).`)
		} catch (error) {
			if (abortSignal.aborted) throw error
			const log = path.join(installLogDirectory, `${repository.replaceAll('/', '_')}.log`)
			const stopped = installTimeout.aborted ? `Stopped after ${String(installTimeoutMinutes)} minutes.\n` : ''
			await mkdir(installLogDirectory, { recursive: true })
			await writeFile(log, `${stopped}${outputOf(error)}`)
			return result('failed', `Installing the npm dependencies of ${repository} failed; the output is in ${log}.`)
		}
	},
})

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

/**
 * Adds `pattern` to the checkout's own ignore list, which isn't committed, unless it's there. Git
 * says where that list is, since `.git` can be a file (a worktree) and `info/` can be missing. A
 * folder that isn't a checkout is left alone.
 */
async function excludeFromGit(directory: string, pattern: string, abortSignal: AbortSignal): Promise<void> {
	const located = await execFileAsync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: directory, signal: abortSignal }).catch(
		(error: unknown) => {
			// Not a checkout: there is no git to keep node_modules out of.
			if (abortSignal.aborted) throw error
			return undefined
		},
	)
	if (located === undefined) return
	const exclude = path.resolve(directory, located.stdout.trim())
	const current = await readFile(exclude, 'utf8').catch(() => '')
	if (current.split('\n').includes(pattern)) return
	await mkdir(path.dirname(exclude), { recursive: true })
	await appendFile(exclude, `${current === '' || current.endsWith('\n') ? '' : '\n'}${pattern}\n`)
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
