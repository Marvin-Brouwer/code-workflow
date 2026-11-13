import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { runGit } from '@mesh-flow/git'

/** Enough of the hash to tell two states of a checkout apart. */
const stateCharacters = 16

/**
 * A short fingerprint of what a checkout holds against `origin/<defaultBranch>`: its commit, its
 * changes, committed or not, and its untracked files. The same changes give the same fingerprint,
 * and any change gives another, so a review loop that renders it is a loop of its own per state.
 */
export async function treeState(directory: string, defaultBranch: string, abortSignal: AbortSignal): Promise<string> {
	const git = async (args: readonly string[]) => {
		const result = await runGit(args, { cwd: directory, abortSignal })
		if (!result.ok) throw new Error(`${result.command.join(' ')} failed in ${directory}:\n${result.stderr}`)
		return result.stdout
	}
	const head = await git(['rev-parse', 'HEAD'])
	const diff = await git(['diff', '--binary', `origin/${defaultBranch}`])
	const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).toSorted()
	const hash = createHash('sha256').update(head).update('\0').update(diff)
	for (const file of untracked)
		hash
			.update('\0')
			.update(file)
			.update('\0')
			.update(await readFile(path.join(directory, file)))
	return hash.digest('hex').slice(0, stateCharacters)
}
