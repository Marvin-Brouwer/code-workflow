import { toPrompt, type RendersInPrompt } from '@mesh-flow/core'
import type { GitClient } from '@mesh-flow/git'

/** A file of the repository as the merge target has it. In a prompt it renders as its path and its text. */
export interface RepositoryFile {
	/** Relative to the repository's root, POSIX. */
	readonly path: string
	readonly text: string
	[toPrompt](): string
}

/** How much of one file goes into a prompt: a template or a lint setting is far smaller. */
const maxCharacters = 16_000

/**
 * The fence around a file in a prompt: longer than the fences a template or a README may hold
 * itself, so theirs stay inside it.
 */
const fence = '`````'

/** Where GitHub looks for a pull request template, lower case: one file, or a folder of several. */
const templateFiles = new Set(['pull_request_template.md', '.github/pull_request_template.md', 'docs/pull_request_template.md'])
const templateFolders = ['pull_request_template/', '.github/pull_request_template/', 'docs/pull_request_template/']

/** Where commitlint looks for its settings, lower case, besides `commitlint` in `package.json`. */
const commitlintConfig = /^(\.commitlintrc(\.(json|ya?ml|[cm]?js|[cm]?ts))?|commitlint\.config\.[cm]?[jt]s)$/

/** A GitHub workflow that lints commit messages or pull request titles: commitlint, or a check of the PR title. */
const workflowFile = /^\.github\/workflows\/[^/]+\.ya?ml$/
const lintsInWorkflow = /commitlint|semantic-pull-request|pr-title|pull-request-title/i

/** The repository's files at `ref`, by path. */
export async function filesAt(git: GitClient, ref: string): Promise<string[]> {
	const { stdout } = await git.lsTree('-r', '-z', '--name-only', ref)
	return stdout.split('\0').filter((entry) => entry !== '')
}

/** The pull request templates at `ref`: GitHub's one file, or every Markdown file in its folder of templates. */
export async function pullRequestTemplates(git: GitClient, ref: string, files: readonly string[]): Promise<RepositoryFile[]> {
	const templates = files.filter((file) => {
		const lower = file.toLowerCase()
		if (templateFiles.has(lower)) return true
		return templateFolders.some((folder) => lower.startsWith(folder) && !lower.slice(folder.length).includes('/') && lower.endsWith('.md'))
	})
	return Promise.all(templates.map((file) => repositoryFile(git, ref, file)))
}

/**
 * The settings at `ref` that lint commit messages or pull request titles: commitlint's settings
 * file or its key in `package.json`, and the GitHub workflows that run such a lint.
 */
export async function lintSettings(git: GitClient, ref: string, files: readonly string[]): Promise<RepositoryFile[]> {
	const found: RepositoryFile[] = []
	for (const file of files) {
		if (commitlintConfig.test(file.toLowerCase())) found.push(await repositoryFile(git, ref, file))
	}
	if (files.includes('package.json')) {
		const settings = commitlintInPackage(await show(git, ref, 'package.json'))
		if (settings !== undefined) found.push(repositoryFileOf('package.json', settings))
	}
	for (const file of files.filter((candidate) => workflowFile.test(candidate))) {
		const text = await show(git, ref, file)
		if (lintsInWorkflow.test(text)) found.push(repositoryFileOf(file, text))
	}
	return found
}

/** A list of files as a prompt takes it: each one's path, then its text in a fence. */
export function filesInPrompt(files: readonly RepositoryFile[]): RendersInPrompt {
	return Object.freeze({ [toPrompt]: () => files.map((file) => file[toPrompt]()).join('\n\n') })
}

/** A pull request's title and description as a prompt takes them, the description fenced like a file. */
export function textInPrompt(text: { readonly title: string; readonly description: string }): RendersInPrompt {
	return Object.freeze({ [toPrompt]: () => `Title: ${text.title}\nDescription:\n${fence}\n${text.description.trimEnd()}\n${fence}` })
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

async function repositoryFile(git: GitClient, ref: string, file: string): Promise<RepositoryFile> {
	return repositoryFileOf(file, await show(git, ref, file))
}

async function show(git: GitClient, ref: string, file: string): Promise<string> {
	return (await git.show(`${ref}:${file}`)).stdout
}

function repositoryFileOf(file: string, whole: string): RepositoryFile {
	const text = whole.length > maxCharacters ? `${whole.slice(0, maxCharacters)}\n(cut off here: the file goes on)` : whole
	return Object.freeze({ path: file, text, [toPrompt]: () => `${file}:\n${fence}\n${text.trimEnd()}\n${fence}` })
}
