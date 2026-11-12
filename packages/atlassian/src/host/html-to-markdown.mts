import TurndownService from 'turndown'

/**
 * Turns the HTML Jira and Confluence render their rich text to into Markdown for agents to read.
 * Tables stay HTML: Markdown can't hold a table with lists or line breaks in its cells, and agents
 * read HTML tables fine.
 */
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' }).keep(['table'])

/** Markdown for rendered rich text; empty for none. */
export function htmlToMarkdown(html: string | null | undefined): string {
	if (html === null || html === undefined || html.trim() === '') return ''
	return turndown.turndown(html).trim()
}
