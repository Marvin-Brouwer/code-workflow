import type { GitClient } from '@mesh-flow/git'
import { capped } from './capped.mts'
import { fenced } from './fenced.mts'

/** A file of the repository as the merge target has it. */
export interface RepositoryFile {
	/** Relative to the repository's root, POSIX. */
	readonly path: string
	readonly text: string
}

/** Where GitHub looks for a pull request template, lower case: the root, `.github/` and `docs/`. */
const templateRoots = ['', '.github/', 'docs/']

/** The one template file GitHub takes in each of {@link templateRoots}. */
const templateFiles = new Set(templateRoots.map((root) => `${root}pull_request_template.md`))

/** The folder of several templates GitHub takes in each of {@link templateRoots}. */
const templateFolders = templateRoots.map((root) => `${root}pull_request_template/`)

/** The folders a template or a lint setting can be in, lower case, besides the repository's root. */
const lookedInFolders = new Set(['.github', 'docs', 'pull_request_template'])

/** The package's manifest, where commitlint's settings may be too. */
const packageFile = 'package.json'

/** Where commitlint looks for its settings, lower case, besides `commitlint` in `package.json`. */
const commitlintConfig = /^(\.commitlintrc(\.(json|ya?ml|[cm]?js|[cm]?ts))?|commitlint\.config\.[cm]?[jt]s)$/

/** A GitHub workflow file. */
const workflowFile = /^\.github\/workflows\/[^/]+\.ya?ml$/

/** What a workflow that lints commit messages or pull request titles mentions: commitlint, or a check of the PR title. */
const lintsInWorkflow = /commitlint|semantic-pull-request|pr-title|pull-request-title/i

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

/** The pull request templates at `ref`: GitHub's one file, or every Markdown file in its folder of templates. */
export async function templatesAt(git: GitClient, ref: string, files: readonly string[]): Promise<RepositoryFile[]> {
	const templates = files.filter((file) => {
		const lower = file.toLowerCase()
		if (templateFiles.has(lower)) return true
		return templateFolders.some((folder) => lower.startsWith(folder) && !lower.slice(folder.length).includes('/') && lower.endsWith('.md'))
	})
	return Promise.all(templates.map((file) => readFileAt(git, ref, file)))
}

/**
 * The settings at `ref` that lint commit messages or pull request titles: commitlint's settings
 * file or its key in `package.json`, and the GitHub workflows that run such a lint.
 */
export async function lintSettingsAt(git: GitClient, ref: string, files: readonly string[]): Promise<RepositoryFile[]> {
	const commitlintPaths = files.filter((file) => commitlintConfig.test(file.toLowerCase()))
	const workflowPaths = files.filter((file) => workflowFile.test(file))
	const [commitlintFiles, inPackage, workflowFiles] = await Promise.all([
		Promise.all(commitlintPaths.map((file) => readFileAt(git, ref, file))),
		files.includes(packageFile) ? textAt(git, ref, packageFile).then(commitlintInPackage) : undefined,
		Promise.all(workflowPaths.map((file) => readFileAt(git, ref, file))),
	])
	return [
		...commitlintFiles,
		...(inPackage === undefined ? [] : [{ path: packageFile, text: inPackage }]),
		...workflowFiles.filter((file) => lintsInWorkflow.test(file.text)),
	]
}

/** Files as a prompt takes them: each one's path, then its text in a fence. */
export function filesInPrompt(files: readonly RepositoryFile[]): string {
	return files.map((file) => `${file.path}:\n${fenced(file.text)}`).join('\n\n')
}

function entries(listing: string): string[] {
	return listing.split('\0').filter((entry) => entry !== '')
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

/** A file at `ref`, cut off when it's too long for a prompt. */
async function readFileAt(git: GitClient, ref: string, file: string): Promise<RepositoryFile> {
	return { path: file, text: capped(await textAt(git, ref, file), 'the file goes on') }
}

/** A file's text at `ref`. */
async function textAt(git: GitClient, ref: string, file: string): Promise<string> {
	return (await git.show(`${ref}:${file}`)).stdout
}
