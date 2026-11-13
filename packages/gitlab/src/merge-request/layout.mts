import type { ChangeRequestLayout } from '@mesh-flow/code-repository'

/** Where GitLab keeps merge request templates, lower case: one Markdown file per template. */
const templateFolder = '.gitlab/merge_request_templates/'

/** GitLab's CI file at the root, and the files a project often includes from `.gitlab/ci/`. */
const ciFile = /^(\.gitlab-ci\.ya?ml|\.gitlab\/ci\/[^/]+\.ya?ml)$/i

/** Where GitLab keeps merge request templates and CI files. */
export const gitlabLayout: ChangeRequestLayout = Object.freeze({
	folders: new Set(['.gitlab']),
	subfolders: new Set(['.gitlab/merge_request_templates', '.gitlab/ci']),
	isTemplate: (lower: string) =>
		lower.startsWith(templateFolder) && !lower.slice(templateFolder.length).includes('/') && lower.endsWith('.md'),
	isCiFile: (file: string) => ciFile.test(file),
})
