import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt } from '@mesh-flow/core'
import { gitCommand } from '@mesh-flow/git'
import type { ReviewedCheckout } from '../../src/_module/preset-development.mts'
import { temporaryDirectory } from './temporary-directory.mts'

/** Long enough to set up a repository on a busy runner. */
const setupTimeoutMs = 10_000

/** Commits every change to tracked files, as a test's own committer. */
export async function commit(directory: string, message: string, abortSignal: AbortSignal): Promise<void> {
	const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com']
	await gitCommand([...identity, 'commit', '--quiet', '--all', '--message', message], { cwd: directory, abortSignal })
}

/** A git repository with one commit that `origin/main` points at, as a fresh checkout has, rendering as its directory. */
export async function gitCheckout(): Promise<ReviewedCheckout> {
	const directory = await temporaryDirectory()
	const abortSignal = AbortSignal.timeout(setupTimeoutMs)
	const git = async (...args: string[]) => {
		await gitCommand(args, { cwd: directory, abortSignal })
	}
	await git('init', '--quiet', '--initial-branch=main')
	await writeFile(path.join(directory, 'README.md'), '# api\n')
	await git('add', '.')
	await commit(directory, 'Start', abortSignal)
	await git('update-ref', 'refs/remotes/origin/main', 'HEAD')
	return { name: 'team/api', directory, defaultBranch: 'main', [toPrompt]: () => directory }
}
