import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { toPrompt } from '@mesh-flow/core'
import { runGit } from '@mesh-flow/git'
import type { ReviewedCheckout } from '../../src/_module/preset-development.mts'
import { temporaryDirectory } from './temporary-directory.mts'

/** A git repository with one commit that `origin/main` points at, as a fresh checkout has, rendering as its directory. */
export async function gitCheckout(): Promise<ReviewedCheckout> {
	const directory = await temporaryDirectory()
	const abortSignal = new AbortController().signal
	const git = (...args: string[]) => runGit(args, { cwd: directory, abortSignal })
	await git('init', '--quiet', '--initial-branch=main')
	await writeFile(path.join(directory, 'README.md'), '# api\n')
	await git('add', '.')
	await git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--message', 'Start')
	await git('update-ref', 'refs/remotes/origin/main', 'HEAD')
	return { name: 'team/api', directory, defaultBranch: 'main', [toPrompt]: () => directory }
}
