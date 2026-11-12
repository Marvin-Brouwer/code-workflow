import {
	filesAt as filesIn,
	lintSettingsAt as lintSettingsIn,
	templatesAt as templatesIn,
	type ChangeRequestLayout,
} from '@mesh-flow/forge'
import type { GitClient } from '@mesh-flow/git'

export { filesInPrompt, type RepositoryFile } from '@mesh-flow/forge'

/** Where GitHub looks for a pull request template, lower case: the root, `.github/` and `docs/`. */
const templateRoots = ['', '.github/', 'docs/']

/** The one template file GitHub takes in each of {@link templateRoots}. */
const templateFiles = new Set(templateRoots.map((root) => `${root}pull_request_template.md`))

/** The folder of several templates GitHub takes in each of {@link templateRoots}. */
const templateFolders = templateRoots.map((root) => `${root}pull_request_template/`)

/** A GitHub workflow file. */
const workflowFile = /^\.github\/workflows\/[^/]+\.ya?ml$/

/** Where GitHub keeps pull request templates and workflows. */
export const githubLayout: ChangeRequestLayout = Object.freeze({
	folders: new Set(['.github', 'docs', 'pull_request_template']),
	subfolders: new Set(['.github/workflows', '.github/pull_request_template', 'docs/pull_request_template']),
	/** GitHub's one file, or every Markdown file in its folder of templates. */
	isTemplate: (lower: string) =>
		templateFiles.has(lower) ||
		templateFolders.some((folder) => lower.startsWith(folder) && !lower.slice(folder.length).includes('/') && lower.endsWith('.md')),
	isCiFile: (file: string) => workflowFile.test(file),
})

/** The paths at `ref` where a template or a lint setting can be on GitHub. */
export function filesAt(git: GitClient, ref: string) {
	return filesIn(git, ref, githubLayout)
}

/** The pull request templates at `ref`. */
export function templatesAt(git: GitClient, ref: string, files: readonly string[]) {
	return templatesIn(git, ref, files, githubLayout)
}

/** The settings at `ref` that lint commit messages or pull request titles, the GitHub workflows that run such a lint among them. */
export function lintSettingsAt(git: GitClient, ref: string, files: readonly string[]) {
	return lintSettingsIn(git, ref, files, githubLayout)
}
