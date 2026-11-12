import { toPrompt, type RendersInPrompt } from '@mesh-flow/core'
import type { GitClient } from '@mesh-flow/git'
import { fenced } from './fenced.mts'

/** A file of the repository as the merge target has it. In a prompt it renders as its path and its text. */
export interface RepositoryFile {
	/** Relative to the repository's root, POSIX. */
	readonly path: string
	readonly text: string
	[toPrompt](): string
}

/** How much of one file goes into a prompt: a template or a lint setting is far smaller. */
const maxFileCharacters = 16_000

/** Where GitHub looks for a pull request template, lower case: one file, or a folder of several. */
const templateFiles = new Set(['pull_request_template.md', '.github/pull_request_template.md', 'docs/pull_request_template.md'])
const templateFolders = ['pull_request_template/', '.github/pull_request_template/', 'docs/pull_request_template/']

/** The package's manifest, where commitlint's settings may be too. */
const packageFile = 'package.json'

/** Where commitlint looks for its settings, lower case, besides `commitlint` in `package.json`. */
const commitlintConfig = /^(\.commitlintrc(\.(json|ya?ml|[cm]?js|[cm]?ts))?|commitlint\.config\.[cm]?[jt]s)$/

/** A GitHub workflow that lints commit messages or pull request titles: commitlint, or a check of the PR title. */
const workflowFile = /^\.github\/workflows\/[^/]+\.ya?ml$/
const lintsInWorkflow = /commitlint|semantic-pull-request|pr-title|pull-request-title/i

/** The folders a template or a lint setting can be in, lower case, besides the repository's root. */
const lookedInFolders = new Set(['.github', 'docs', 'pull_request_template'])

/**
 * The paths at `ref` where a template or a lint setting can be: the root's entries and everything
 * in {@link lookedInFolders}. Never the whole tree, which a large repository's listing is too big for.
 */
export async function filesAt(git: GitClient, ref: string): Promise<string[]> {
	const root = entries((await git.lsTree('-z', '--name-only', ref)).stdout)
	const folders = root.filter((entry) => lookedInFolders.has(entry.toLowerCase()))
	if (folders.length === 0) return root
	return [...root, ...entries((await git.lsTree('-r', '-z', '--name-only', ref, '--', ...folders)).stdout)]
}

function entries(listing: string): string[] {
	return listing.split('\0').filter((entry) => entry !== '')
}

/** The pull request templates at `ref`: GitHub's one file, or every Markdown file in its folder of templates. */
export async function pullRequestTemplates(git: GitClient, ref: string, files: readonly string[]): Promise<RepositoryFile[]> {
	const templates = files.filter((file) => {
		const lower = file.toLowerCase()
		if (templateFiles.has(lower)) return true
		return templateFolders.some((folder) => lower.startsWith(folder) && !lower.slice(folder.length).includes('/') && lower.endsWith('.md'))
	})
	return Promise.all(templates.map((file) => readRepositoryFile(git, ref, file)))
}

/**
 * The settings at `ref` that lint commit messages or pull request titles: commitlint's settings
 * file or its key in `package.json`, and the GitHub workflows that run such a lint.
 */
export async function lintSettings(git: GitClient, ref: string, files: readonly string[]): Promise<RepositoryFile[]> {
	const commitlintPaths = files.filter((file) => commitlintConfig.test(file.toLowerCase()))
	const workflowPaths = files.filter((file) => workflowFile.test(file))
	const [commitlintFiles, inPackage, workflowFiles] = await Promise.all([
		Promise.all(commitlintPaths.map((file) => readRepositoryFile(git, ref, file))),
		files.includes(packageFile) ? show(git, ref, packageFile).then(commitlintInPackage) : undefined,
		Promise.all(workflowPaths.map((file) => readRepositoryFile(git, ref, file))),
	])
	return [
		...commitlintFiles,
		...(inPackage === undefined ? [] : [repositoryFile(packageFile, inPackage)]),
		...workflowFiles.filter((file) => lintsInWorkflow.test(file.text)),
	]
}

/** A list of files as a prompt takes it: each one's path, then its text in a fence. */
export function filesInPrompt(files: readonly RepositoryFile[]): RendersInPrompt {
	return Object.freeze({ [toPrompt]: () => files.map((file) => file[toPrompt]()).join('\n\n') })
}

/** `commitlint` in a `package.json`, as JSON of its own: the rest of the file says nothing about lint. */
function commitlintInPackage(text: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(text)
		if (typeof parsed !== 'object' || parsed === null || !Object.hasOwn(parsed, 'commitlint')) return undefined
		const commitlint: unknown = Reflect.get(parsed, 'commitlint')
		return JSON.stringify({ commitlint }, undefined, '\t')
	} catch {
		// A package.json that isn't JSON lints nothing, and its own tooling will say so.
		return undefined
	}
}

async function readRepositoryFile(git: GitClient, ref: string, file: string): Promise<RepositoryFile> {
	return repositoryFile(file, await show(git, ref, file))
}

async function show(git: GitClient, ref: string, file: string): Promise<string> {
	return (await git.show(`${ref}:${file}`)).stdout
}

function repositoryFile(file: string, whole: string): RepositoryFile {
	const text = whole.length > maxFileCharacters ? `${whole.slice(0, maxFileCharacters)}\n(cut off here: the file goes on)` : whole
	return Object.freeze({ path: file, text, [toPrompt]: () => `${file}:\n${fenced(text)}` })
}
