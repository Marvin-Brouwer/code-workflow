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
	readonly head: string
	/** The branch's commits, oldest first: subject, then body. */
	readonly commits: string
	/** `git diff --stat` against where the branch left the merge target. */
	readonly stat: string
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

/**
 * The tool that reads what a checkout's branch changes against the default branch and how the
 * repository wants a pull request written. The template and the lint settings are read as the
 * default branch has them, so a change on the branch itself doesn't decide how it is described.
 */
export function brief(repository: Repository) {
	return tool('githubPullRequestBrief', {
		description: `Reads what the branch of ${repository.path} changes and how the repository wants a pull request written`,
		input: z.object({}),
		action: async (_, { abortSignal }): Promise<PullRequestBrief> => {
			const git = localGit(repository.directory, abortSignal)
			const target = `refs/remotes/${origin}/${repository.defaultBranch}`
			const head = (await git.revParse('HEAD')).stdout.trim()
			const commits = (await git.log('--reverse', '--format=- %s%n%w(0,2,2)%b', `${target}..HEAD`)).stdout
			// Three dots: against where the branch left the target, as the pull request shows it.
			const stat = (await git.diff(`--stat=${String(statWidth)}`, `${target}...HEAD`)).stdout
			const file = workspace.file(`${diffsFolder.path}/${repository.path}/${repository.branch}.diff`)
			await file.write((await git.diff(`${target}...HEAD`)).stdout)
			const location = file.location()
			const files = await filesAt(git, target)
			return Object.freeze({
				base: repository.defaultBranch,
				head,
				commits,
				stat,
				diff: Object.freeze({ [toPrompt]: () => location }),
				templates: await pullRequestTemplates(git, target, files),
				lintSettings: await lintSettings(git, target, files),
			})
		},
	})
}
