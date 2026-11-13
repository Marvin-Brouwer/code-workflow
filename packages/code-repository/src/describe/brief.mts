import { tool, workspace, type Tool } from '@mesh-flow/core'
import { z } from 'zod'
import { Sha } from '../checkout/bundle-schemas.mts'
import type { Checkout } from '../checkout/checkout.mts'
import { localGit } from '../checkout/local-git.mts'
import { trackingRef } from '../checkout/tracking.mts'
import { capped } from './capped.mts'
import { pascalCase, type CodeHostTerms } from './change-request.mts'
import { filesAt, lintSettingsAt, templatesAt, type ChangeRequestLayout, type RepositoryFile } from './repository-files.mts'

/** What an agent needs to describe a branch: what it changes against the merge target, and the repository's rules for describing it. */
export interface ChangeBrief {
	/** The branch it merges into. */
	readonly base: string
	/** The commit it describes. */
	readonly headSha: string
	/** The branch's commits, oldest first: subject, then body. */
	readonly commitLog: string
	/** `git diff --stat` against where the branch left the merge target. */
	readonly diffStat: string
	/** The absolute path of the file in the workspace with the whole diff. */
	readonly diffPath: string
	/** The repository's pull or merge request templates; none when it has none. */
	readonly templates: readonly RepositoryFile[]
	/** The repository's settings that lint commit messages or titles; none when it has none. */
	readonly lintSettings: readonly RepositoryFile[]
}

/** Where the diffs of the branches are written, for agents to read. */
function diffsFolder(terms: CodeHostTerms) {
	return workspace.folder(`${terms.request.replaceAll(' ', '-')}s`, {
		description: `what each ${terms.request} of this run changes, one diff per branch`,
	})
}

/** How wide `git diff --stat` may be, in columns: wide enough that paths keep their names. */
const statWidthColumns = 160

/** One commit per bullet: its subject, then its body indented two spaces. */
const commitLogFormat = '- %s%n%w(0,2,2)%b'

/** Characters git allows in a branch name and Windows doesn't in a file name. */
const notInFileNames = /[<>:"|?*\\]/g

/** A path segment Windows takes as a device, or trims the end of: `con`, `aux`, `com1`, or one ending in a dot or a space. */
const notAFileOnWindows = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$|[. ]$/i

/** Where in the workspace the diff of the branch goes: its path with each segment safe as a file name on Windows too. */
function diffFilePath(repository: Checkout, terms: CodeHostTerms): string {
	const segments = repository.branch.split('/').map((segment) => {
		const safe = segment.replace(notInFileNames, '-')
		return notAFileOnWindows.test(safe) ? `${safe}-` : safe
	})
	return `${diffsFolder(terms).path}/${repository.path}/${segments.join('/')}.diff`
}

/**
 * The tool that reads what a checkout's branch changes against the default branch at commit
 * `head`, and how the repository wants a pull or merge request written. The template and the lint
 * settings are read as the default branch has them, so a change on the branch itself doesn't decide
 * how it is described. A branch without commits of its own is refused, since there is nothing to
 * describe and no code host takes a request for it.
 */
export function readBrief(repository: Checkout, terms: CodeHostTerms, layout: ChangeRequestLayout): Tool<{ head: string }, ChangeBrief> {
	return tool(`${terms.toolPrefix}${pascalCase(terms.request)}Brief`, {
		description: `Reads what the branch of ${repository.directory} changes and how the repository wants a ${terms.request} written`,
		input: z.object({ head: Sha }),
		action: async ({ head }, { abortSignal }): Promise<ChangeBrief> => {
			const git = localGit(repository.directory, abortSignal)
			const target = trackingRef(repository.defaultBranch)
			const log = (await git.log('--reverse', `--format=${commitLogFormat}`, `${target}..${head}`)).stdout
			if (log.trim() === '')
				throw new Error(`${repository.branch} has no commits on top of ${repository.defaultBranch}: there is nothing to describe.`)
			// Three dots: against where the branch left the target, as the request shows it.
			const range = `${target}...${head}`
			const file = workspace.file(diffFilePath(repository, terms))
			// Makes the file and its folders, for `git diff --output` to write into.
			await file.write('')
			const diffPath = file.location()
			const files = await filesAt(git, target, layout)
			const [diffStat, templates, lintSettings] = await Promise.all([
				git.diff(`--stat=${String(statWidthColumns)}`, range).then(({ stdout }) => capped(stdout, 'more files follow, see the diff file')),
				templatesAt(git, target, files, layout),
				lintSettingsAt(git, target, files, layout),
				// Straight into the file: a diff can be larger than what git's output may be in memory.
				git.diff(`--output=${diffPath}`, range),
			])
			return Object.freeze({
				base: repository.defaultBranch,
				headSha: head,
				commitLog: capped(log, 'more commits follow'),
				diffStat,
				diffPath,
				templates,
				lintSettings,
			})
		},
	})
}
