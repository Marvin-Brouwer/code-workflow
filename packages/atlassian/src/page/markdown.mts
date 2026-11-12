import type { PageData } from '../tools/page-tools.mts'

/** The page as Markdown: a heading with its title, its facts, then its body. */
export function pageMarkdownOf(data: PageData): string {
	const body = data.body.trim()
	return [
		`# ${data.title}`,
		'',
		`- URL: ${data.url}`,
		`- Space: ${data.space}`,
		`- Version: ${String(data.version)}`,
		`- Updated: ${data.updated}`,
		'',
		body === '' ? '(empty page)' : body,
		'',
	].join('\n')
}
