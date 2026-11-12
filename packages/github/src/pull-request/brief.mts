import { tool, toPrompt, workspace, type RendersInPrompt } from '@mesh-flow/core'
import { z } from 'zod'
import { localGit } from '../repository/local-git.mts'
import { origin, type Repository } from '../repository/repository.mts'
import { filesAt, lintSettings, pullRequestTemplates, type RepositoryFile } from './repository-files.mts'

/** What an agent needs to describe a branch: what it changes against the merge target, and the repository's rules for describing it. */
export interface PullRequestBrief {
	/** The branch it merges into. */
	readonly base: string
	/** The commit it describes: the checkout's `HEAD`. */
	readonly headSha: string
	/** The branch's commits, oldest first: subject, then body. */
	readonly commitLog: string
	/** `git diff --stat` against where the branch left the merge target. */
	readonly diffStat: string
	/** The whole diff, as a file in the workspace. In a prompt it renders as its absolute path. */
	readonly diff: RendersInPrompt
	/** The repository's pull request templates; none when it has none. */
	readonly templates: readonly RepositoryFile[]
	/** The repository's settings that lint commit messages or pull request titles; none when it has none. */
	readonly lintSettings: readonly RepositoryFile[]
}

/** Where the diffs of the branches are written, for agents to read. */
const diffsFolder = workspace.folder('pull-requests', { description: 'what each pull request of this run changes, one diff per branch' })

/** How wide `git diff --stat` may be: wide enough that paths keep their names. */
const statWidth = 160

/** How much of the commit log or the diff stat goes into the prompt; the whole diff is in its file. */
const maxListingCharacters = 16_000

/** Characters git allows in a branch name and Windows doesn't in a file name. */
const notInFileNames = /[<>:"|?*\\]/g

/**
 * The tool that reads what a checkout's branch changes against the default branch and how the
 * repository wants a pull request written. The template and the lint settings are read as the
 * default branch has them, so a change on the branch itself doesn't decide how it is described.
 * The branch is described as it is committed, so a checkout with uncommitted changes is refused.
 */
export function readBrief(repository: Repository) {
	return tool('githubPullRequestBrief', {
		description: `Reads what the branch of ${repository.path} changes and how the repository wants a pull request written`,
		input: z.object({}),
		action: async (_, { abortSignal }): Promise<PullRequestBrief> => {
			const git = localGit(repository.directory, abortSignal)
			if ((await git.dirtyFiles()).length > 0)
				throw new Error(`${repository.path} has changes that aren't committed: push them before the branch is described.`)
			const target = `refs/remotes/${origin}/${repository.defaultBranch}`
			// Three dots: against where the branch left the target, as the pull request shows it.
			const range = `${target}...HEAD`
			const file = workspace.file(`${diffsFolder.path}/${repository.path}/${repository.branch.replace(notInFileNames, '-')}.diff`)
			await file.write('')
			const location = file.location()
			const files = await filesAt(git, target)
			const [headSha, commitLog, diffStat, templates, settings] = await Promise.all([
				git.revParse('HEAD').then(({ stdout }) => stdout.trim()),
				git.log('--reverse', '--format=- %s%n%w(0,2,2)%b', `${target}..HEAD`).then(({ stdout }) => capped(stdout, 'commits')),
				git.diff(`--stat=${String(statWidth)}`, range).then(({ stdout }) => capped(stdout, 'files')),
				pullRequestTemplates(git, target, files),
				lintSettings(git, target, files),
				// Straight into the file: a diff can be larger than what git's output may be in memory.
				git.diff(`--output=${location}`, range),
			])
			return Object.freeze({
				base: repository.defaultBranch,
				headSha,
				commitLog,
				diffStat,
				diff: Object.freeze({ [toPrompt]: () => location }),
				templates,
				lintSettings: settings,
			})
		},
	})
}

/** `listing` as the prompt takes it: cut off, with a note, past {@link maxListingCharacters}. */
function capped(listing: string, what: string): string {
	if (listing.length <= maxListingCharacters) return listing
	return `${listing.slice(0, maxListingCharacters)}\n(cut off here: more ${what} follow, see the diff file)`
}
