import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { temporaryDirectory } from './temporary-directory.mts'

/** Runs git in `cwd` and returns its output. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execa('git', args, {
		cwd,
		env: {
			GIT_AUTHOR_NAME: 'Test',
			GIT_AUTHOR_EMAIL: 'test@example.com',
			GIT_COMMITTER_NAME: 'Test',
			GIT_COMMITTER_EMAIL: 'test@example.com',
		},
	})
	return stdout
}

/** A bare repository standing in for GitHub, with one commit on `main`, and its `file://` URL. */
export interface LocalRemote {
	readonly directory: string
	readonly url: string
	/** The commit a branch of the remote is at. */
	head(branch: string): Promise<string>
	/** The files in a branch of the remote. */
	files(branch: string): Promise<string[]>
	/** Adds a commit to a branch of the remote, through a work tree of its own. */
	commit(branch: string, file: string, contents: string): Promise<void>
}

export async function localRemote(): Promise<LocalRemote> {
	const root = await temporaryDirectory()
	const directory = path.join(root, 'remote.git')
	const work = path.join(root, 'work')
	await git(root, 'init', '--bare', '--quiet', '--initial-branch=main', directory)
	await git(root, 'clone', '--quiet', directory, work)
	await writeFile(path.join(work, 'README.md'), '# Example\n')
	await git(work, 'add', '--all')
	await git(work, 'commit', '--quiet', '--message', 'Start')
	await git(work, 'push', '--quiet', 'origin', 'main')
	await git(directory, 'symbolic-ref', 'HEAD', 'refs/heads/main')
	return {
		directory,
		url: pathToFileURL(directory).href,
		head: async (branch) => (await git(directory, 'rev-parse', `refs/heads/${branch}`)).trim(),
		files: async (branch) => (await git(directory, 'ls-tree', '--name-only', '-r', branch)).split('\n').filter(Boolean),
		async commit(branch, file, contents) {
			await git(work, 'fetch', '--quiet', 'origin')
			await git(work, 'checkout', '--quiet', '-B', branch, `origin/${branch}`).catch(() => git(work, 'checkout', '--quiet', '-B', branch))
			await mkdir(path.dirname(path.join(work, file)), { recursive: true })
			await writeFile(path.join(work, file), contents)
			await git(work, 'add', '--all')
			await git(work, 'commit', '--quiet', '--message', `Change ${file}`)
			await git(work, 'push', '--quiet', 'origin', branch)
		},
	}
}
