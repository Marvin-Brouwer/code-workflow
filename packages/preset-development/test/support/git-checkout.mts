import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt } from '@mesh-flow/core'
import { gitCommand } from '@mesh-flow/git'
import type { ReviewedCheckout } from '../../src/_module/preset-development.mts'
import { temporaryDirectory } from './temporary-directory.mts'

/** Long enough to set up a repository on a busy runner. */
const setupTimeoutMs = 10_000

/** A git repository with one commit that `origin/main` points at, as a fresh checkout has, rendering as its directory. */
export async function gitCheckout(): Promise<ReviewedCheckout> {
	const directory = await temporaryDirectory()
	const abortSignal = AbortSignal.timeout(setupTimeoutMs)
	const git = async (...args: string[]) => gitCommand(args, { cwd: directory, abortSignal })
	await git('init', '--quiet', '--initial-branch=main')
	await writeFile(path.join(directory, 'README.md'), '# api\n')
	await git('add', '.')
	await git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--message', 'Start')
	await git('update-ref', 'refs/remotes/origin/main', 'HEAD')
	return { name: 'team/api', directory, defaultBranch: 'main', [toPrompt]: () => directory }
}
