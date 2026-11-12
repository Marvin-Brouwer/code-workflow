import { tool, workspace } from '@mesh-flow/core'
import { z } from 'zod'
import { localGit } from '../repository/local-git.mts'
import { origin, type Repository } from '../repository/repository.mts'
import { capped } from './capped.mts'
import { filesAt, lintSettingsAt, templatesAt, type RepositoryFile } from './repository-files.mts'

/** What an agent needs to describe a branch: what it changes against the merge target, and the repository's rules for describing it. */
export interface PullRequestBrief {
	/** The branch it merges into. */
	readonly base: string
	/** The commit it describes. */
	readonly headSha: string
	/** The branch's commits, oldest first: subject, then body. */
	readonly commitLog: string
	/** `git diff --stat` against where the branch left the merge target. */
	readonly diffStat: string
	/** The whole diff: the absolute path of its file in the workspace. */
	readonly diff: string
	/** The repository's pull request templates; none when it has none. */
	readonly templates: readonly RepositoryFile[]
	/** The repository's settings that lint commit messages or pull request titles; none when it has none. */
	readonly lintSettings: readonly RepositoryFile[]
}

/** Where the diffs of the branches are written, for agents to read. */
const diffsFolder = workspace.folder('pull-requests', { description: 'what each pull request of this run changes, one diff per branch' })

/** How wide `git diff --stat` may be: wide enough that paths keep their names. */
const statWidth = 160

/** Characters git allows in a branch name and Windows doesn't in a file name. */
const notInFileNames = /[<>:"|?*\\]/g

/**
 * The tool that reads what a checkout's branch changes against the default branch and how the
 * repository wants a pull request written. The template and the lint settings are read as the
 * default branch has them, so a change on the branch itself doesn't decide how it is described.
 *
 * It reads what is committed: the checkout's `HEAD`, or with `pushed` the branch as it was last
 * pushed, which is what an open pull request shows. A branch without commits of its own is refused,
 * since there is nothing to describe and GitHub takes no pull request for it.
 */
export function readBrief(repository: Repository) {
	return tool('githubPullRequestBrief', {
		description: `Reads what the branch of ${repository.path} changes and how the repository wants a pull request written`,
		input: z.object({ pushed: z.boolean() }),
		action: async ({ pushed }, { abortSignal }): Promise<PullRequestBrief> => {
			const git = localGit(repository.directory, abortSignal)
			const target = `refs/remotes/${origin}/${repository.defaultBranch}`
			const tracking = `refs/remotes/${origin}/${repository.branch}`
			const head = pushed && (await git.hasRef(tracking)) ? tracking : 'HEAD'
			const [headSha, log] = await Promise.all([
				git.revParse(head).then(({ stdout }) => stdout.trim()),
				git.log('--reverse', '--format=- %s%n%w(0,2,2)%b', `${target}..${head}`).then(({ stdout }) => stdout),
			])
			if (log.trim() === '')
				throw new Error(`${repository.branch} has no commits on top of ${repository.defaultBranch}: there is nothing to describe.`)
			// Three dots: against where the branch left the target, as the pull request shows it.
			const range = `${target}...${head}`
			const file = workspace.file(`${diffsFolder.path}/${repository.path}/${repository.branch.replace(notInFileNames, '-')}.diff`)
			// Makes the file and its folders, for `git diff --output` to write into.
			await file.write('')
			const diff = file.location()
			const files = await filesAt(git, target)
			const [diffStat, templates, lintSettings] = await Promise.all([
				git.diff(`--stat=${String(statWidth)}`, range).then(({ stdout }) => capped(stdout, 'more files follow, see the diff file')),
				templatesAt(git, target, files),
				lintSettingsAt(git, target, files),
				// Straight into the file: a diff can be larger than what git's output may be in memory.
				git.diff(`--output=${diff}`, range),
			])
			return Object.freeze({
				base: repository.defaultBranch,
				headSha,
				commitLog: capped(log, 'more commits follow'),
				diffStat,
				diff,
				templates,
				lintSettings,
			})
		},
	})
}
