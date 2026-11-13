import TurndownService from 'turndown'

/**
 * Turns the HTML Jira and Confluence render their rich text to into Markdown for agents to read.
 * Tables stay HTML: Markdown can't hold a table with lists or line breaks in its cells, and agents
 * read HTML tables fine. A mention of a person is `@Name`.
 */
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
	.keep(['table'])
	.addRule('mention', { filter: isMention, replacement: (content) => `@${content.replace(/^@/, '')}` })

/** The classes Jira and Confluence give a link that mentions a person. */
const mentionClasses = ['user-hover', 'user-mention', 'confluence-userlink']

/** What `isMention` reads of a node: without the DOM's types, as the host has no DOM. */
interface RenderedNode {
	readonly nodeName: string
	getAttribute(name: string): string | null
}

/**
 * Whether a node is a mention of a person: a link to their profile, which the agent can't open and
 * reads better as `@Name`, as the person wrote it.
 */
function isMention(node: RenderedNode): boolean {
	if (node.nodeName !== 'A') return false
	const classes = (node.getAttribute('class') ?? '').split(/\s+/)
	return node.getAttribute('data-account-id') !== null || mentionClasses.some((name) => classes.includes(name))
}

/** Markdown for rendered rich text; empty for none. */
export function htmlToMarkdown(html: string | null | undefined): string {
	if (html === null || html === undefined || html.trim() === '') return ''
	return turndown.turndown(html).trim()
}
