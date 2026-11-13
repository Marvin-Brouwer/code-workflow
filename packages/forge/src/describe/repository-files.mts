import type { GitClient } from '@mesh-flow/git'
import { capped } from '@mesh-flow/forge'
import { fenced } from '@mesh-flow/forge'

/** A file of the repository as the merge target has it. */
export interface RepositoryFile {
	/** Relative to the repository's root, POSIX. */
	readonly path: string
	/** The file's text, cut off when it's too long for a prompt. */
	readonly text: string
}

/**
 * Where a forge keeps what describing a change goes by: the folders to look in for templates and
 * CI files, and which files are which. Folders are listed one level each, lower case, never a whole
 * tree, which a large repository's `docs/` alone can be too big to list.
 */
export interface ChangeRequestLayout {
	/** The folders right under the root to look in, such as `.github`. */
	readonly folders: ReadonlySet<string>
	/** The folders one level further down to look in, such as `.github/workflows`. */
	readonly subfolders: ReadonlySet<string>
	/** Whether a file, by its path in lower case, is a template for a pull or merge request. */
	readonly isTemplate: (lowerPath: string) => boolean
	/** Whether a file is a CI file, which may run a lint of commit messages or titles. */
	readonly isCiFile: (path: string) => boolean
}

/** The byte order mark an editor may start a file with, which `JSON.parse` doesn't take. */
const byteOrderMark = '\uFEFF'

/** The package's manifest, where commitlint's settings may be too. */
const packageFile = 'package.json'

/** Where commitlint looks for its settings, lower case, besides `commitlint` in `package.json`. */
const commitlintConfig = /^(\.commitlintrc(\.(json|ya?ml|[cm]?js|[cm]?ts))?|commitlint\.config\.[cm]?[jt]s)$/

/** What a CI file that lints commit messages or titles mentions: commitlint, or a check of the title. */
const lintsInCi = /commitlint|semantic-pull-request|pr-title|pull-request-title|mr-title|merge-request-title/i

/** The paths at `ref` where a template or a lint setting can be: the entries of the root, and of the layout's folders, one level each. */
export async function filesAt(git: GitClient, ref: string, layout: ChangeRequestLayout): Promise<string[]> {
	const root = entries((await git.lsTree('-z', '--name-only', ref)).stdout)
	const inFolders = await entriesOf(
		git,
		ref,
		root.filter((entry) => layout.folders.has(entry.toLowerCase())),
	)
	const inSubfolders = await entriesOf(
		git,
		ref,
		inFolders.filter((entry) => layout.subfolders.has(entry.toLowerCase())),
	)
	return [...root, ...inFolders, ...inSubfolders]
}

/** The entries right in `folders` at `ref`, not in their subfolders. */
async function entriesOf(git: GitClient, ref: string, folders: readonly string[]): Promise<string[]> {
	if (folders.length === 0) return []
	return entries((await git.lsTree('-z', '--name-only', ref, '--', ...folders.map((folder) => `${folder}/`))).stdout)
}

/** The pull or merge request templates at `ref`, as the layout finds them. */
export async function templatesAt(
	git: GitClient,
	ref: string,
	files: readonly string[],
	layout: ChangeRequestLayout,
): Promise<RepositoryFile[]> {
	const templates = files.filter((file) => layout.isTemplate(file.toLowerCase()))
	return Promise.all(templates.map((file) => readFileAt(git, ref, file)))
}

/**
 * The settings at `ref` that lint commit messages or titles: commitlint's settings file or its key
 * in `package.json`, and the CI files that run such a lint.
 */
export async function lintSettingsAt(
	git: GitClient,
	ref: string,
	files: readonly string[],
	layout: ChangeRequestLayout,
): Promise<RepositoryFile[]> {
	const commitlintPaths = files.filter((file) => commitlintConfig.test(file.toLowerCase()))
	const ciPaths = files.filter((file) => layout.isCiFile(file))
	const [commitlintFiles, inPackage, ciFiles] = await Promise.all([
		Promise.all(commitlintPaths.map((file) => readFileAt(git, ref, file))),
		files.includes(packageFile) ? textAt(git, ref, packageFile).then(commitlintInPackage) : undefined,
		Promise.all(ciPaths.map((file) => readFileAt(git, ref, file))),
	])
	return [
		...commitlintFiles,
		...(inPackage === undefined ? [] : [{ path: packageFile, text: inPackage }]),
		...ciFiles.filter((file) => lintsInCi.test(file.text)),
	]
}

/** Files as a prompt takes them: each one's path, then its text in a fence. */
export function filesInPrompt(files: readonly RepositoryFile[]): string {
	return files.map((file) => `${file.path}:\n${fenced(file.text)}`).join('\n\n')
}

/** The entries of a NUL-terminated git listing (`-z`). */
function entries(listing: string): string[] {
	return listing.split('\0').filter((entry) => entry !== '')
}

/** `commitlint` in a `package.json`, as JSON of its own: the rest of the file says nothing about lint. */
function commitlintInPackage(text: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(text.startsWith(byteOrderMark) ? text.slice(byteOrderMark.length) : text)
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
