import type { ChangeRequestLayout } from '@mesh-flow/forge'

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
