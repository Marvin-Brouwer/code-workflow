/**
 * Installs a checkout's npm dependencies, so the developer can run the tests from its first step
 * instead of being asked to install them in the prompt. The sandbox reaches the npm registry and
 * nothing else; see main.mts. Called from code before the developer starts, and a tool the
 * developer can call again after changing the dependencies.
 */
import { execFile } from 'node:child_process'
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { tool, toPrompt, workspace } from '@mesh-flow/core'
import { z } from 'zod'

const execFileAsync = promisify(execFile)

/** npm writes more than execFile's 1 MiB default on a large install, which would count as a failure. */
const maxOutputBytes = 16 * 1024 * 1024

/** An install that takes longer has hung, such as a lifecycle script that waits for input. */
const installTimeoutMs = 10 * 60_000

/**
 * Where a failed install's output goes. The prompt names the file rather than holding the output,
 * which has timestamps in it: the prompt stays the same on a rerun, so the developer's loop resumes.
 */
const installLog = '/var/tmp/install-dependencies.log'

/** How the install went, and in a prompt, a sentence that says so. */
export interface Installed {
	readonly state: 'installed' | 'nothing to install' | 'failed' | 'not handled'
	readonly detail: string
	[toPrompt](): string
}

/** The command for each lockfile, in the order they're looked for. Corepack fetches pnpm from the npm registry. */
const installers = [
	{ lockfile: 'package-lock.json', command: ['npm', 'ci', '--no-audit', '--no-fund'] },
	{ lockfile: 'pnpm-lock.yaml', command: ['corepack', 'pnpm', 'install', '--frozen-lockfile'] },
] as const

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
	action: async ({ repository }, { abortSignal }): Promise<Installed> => {
		const directory = workspace.folder(repository).location()
		if (!(await exists(directory, 'package.json')))
			return installed('nothing to install', `${repository} has no package.json, so it has no npm dependencies.`)
		const unhandled = await firstPresent(directory, notHandled)
		if (unhandled !== undefined)
			return installed(
				'not handled',
				`${repository} has a ${unhandled}, which this install doesn't handle: install its dependencies yourself.`,
			)
		const installer =
			(await firstPresent(
				directory,
				installers.map(({ lockfile }) => lockfile),
			)) ?? 'none'
		const [program, ...args] = installers.find(({ lockfile }) => lockfile === installer)?.command ?? [
			'npm',
			'install',
			'--no-package-lock',
			'--no-audit',
			'--no-fund',
		]
		await excludeFromGit(directory, 'node_modules')
		try {
			await execFileAsync(program, args, {
				cwd: directory,
				signal: AbortSignal.any([abortSignal, AbortSignal.timeout(installTimeoutMs)]),
				maxBuffer: maxOutputBytes,
				env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
			})
			return installed('installed', `The npm dependencies of ${repository} are installed (${[program, ...args].join(' ')}).`)
		} catch (error) {
			if (abortSignal.aborted) throw error
			await writeFile(installLog, outputOf(error))
			return installed('failed', `Installing the npm dependencies of ${repository} failed; the output is in ${installLog}.`)
		}
	},
})

function installed(state: Installed['state'], detail: string): Installed {
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

/** Adds `pattern` to the checkout's own ignore list, which isn't committed, unless it's there. */
async function excludeFromGit(directory: string, pattern: string): Promise<void> {
	const exclude = path.join(directory, '.git', 'info', 'exclude')
	const current = await readFile(exclude, 'utf8').catch(() => '')
	if (current.split('\n').includes(pattern)) return
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
