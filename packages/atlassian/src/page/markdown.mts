import { withFrontmatter } from '../frontmatter.mts'
import type { PageData } from '../tools/page-tools.mts'

/** The page as Markdown: its facts as frontmatter, then a heading with its title, and its body. */
export function pageMarkdownOf(data: PageData): string {
	const body = data.body.trim()
	const metadata = { id: data.id, title: data.title, url: data.url, space: data.space, version: data.version, updated: data.updated }
	return withFrontmatter(metadata, [`# ${data.title}`, '', body === '' ? '(empty page)' : body, ''].join('\n'))
}
