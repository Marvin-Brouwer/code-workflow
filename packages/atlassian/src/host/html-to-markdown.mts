import TurndownService from 'turndown'
import { linkedPerson, mentionKey, mentionRefOf, mentionText, type MentionRef, type Person, type RenderedNode } from './mention.mts'

/** How rich text becomes Markdown: where its images point, and who its mentions are. */
export interface RichTextOptions {
	/** Where an image or link in the Markdown points, for where it pointed in the HTML. Default: where it did. */
	readonly address?: (src: string) => string
	/** The people the site told about, by {@link mentionKey}. A mention of anyone else keeps the name and id its link holds. */
	readonly people?: ReadonlyMap<string, Person>
	/** Called with each mention as the link holds it. */
	readonly onMention?: (mention: MentionRef) => void
}

/** A turndown setup for Jira's and Confluence's rendered HTML, with its images and mentions as `options` say. */
function converter({ address = (src) => src, people = new Map(), onMention }: RichTextOptions): TurndownService {
	const personNamed = (mention: MentionRef) => people.get(mentionKey(mention)) ?? linkedPerson(mention)
	return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
		.addRule('table', {
			filter: 'table',
			// Its cells were read already, so the mentions in it are found; the HTML it stays gets the same images and names.
			replacement: (_content, node: TableNode) => `\n\n${tableHtml(node, address, personNamed)}\n\n`,
		})
		.addRule('mention', {
			filter: (node: RenderedNode) => mentionRefOf(node) !== undefined,
			replacement: (_content, node: RenderedNode) => {
				const mention = mentionRefOf(node)
				if (mention === undefined) return ''
				onMention?.(mention)
				return mentionText(personNamed(mention))
			},
		})
		.addRule('link', {
			filter: (node: RenderedNode) => node.nodeName === 'A' && (node.getAttribute('href') ?? '') !== '' && mentionRefOf(node) === undefined,
			replacement: (content, node: RenderedNode) => `[${content}](${address(node.getAttribute('href') ?? '')})`,
		})
		.addRule('image', {
			filter: 'img',
			replacement: (_content, node: RenderedNode) => {
				const src = node.getAttribute('src') ?? ''
				return src === '' ? '' : `![${altText(node.getAttribute('alt') ?? '')}](${address(src)})`
			},
		})
}

/** What a table's rule needs of it: the elements in it, to change, and its HTML. */
interface TableNode extends RenderedNode {
	readonly outerHTML: string
	readonly parentNode: TableNode | null
	readonly ownerDocument: { createTextNode(text: string): unknown }
	querySelectorAll(selector: string): ArrayLike<TableNode>
	setAttribute(name: string, value: string): void
	replaceWith(node: unknown): void
}

/** A table as HTML, with its images and links pointing where `address` says and its mentions as Markdown does them. */
function tableHtml(table: TableNode, address: (src: string) => string, personNamed: (mention: MentionRef) => Person): string {
	// A table in a table is written as part of the outer one, which changes it once.
	if (insideTable(table)) return ''
	for (const image of Array.from(table.querySelectorAll('img[src]'))) {
		image.setAttribute('src', address(image.getAttribute('src') ?? ''))
	}
	for (const link of Array.from(table.querySelectorAll('a'))) {
		const mention = mentionRefOf(link)
		if (mention !== undefined) link.replaceWith(table.ownerDocument.createTextNode(mentionText(personNamed(mention))))
		else if (link.getAttribute('href') !== null) link.setAttribute('href', address(link.getAttribute('href') ?? ''))
	}
	return table.outerHTML
}

/** Whether a table is inside another one. */
function insideTable(table: TableNode): boolean {
	for (let parent = table.parentNode; parent !== null; parent = parent.parentNode) {
		if (parent.nodeName === 'TABLE') return true
	}
	return false
}

/** An image's alt text as Markdown's brackets can hold it: on one line, with its brackets escaped. */
function altText(alt: string): string {
	return alt.replaceAll(/\s+/g, ' ').replaceAll(/[\\[\]]/g, (character) => `\\${character}`)
}

/**
 * The mentions in rendered rich text, as the links hold them, so the site can be asked who each is
 * first. It converts the text and keeps only the mentions: turndown's parser is the one the host has.
 */
export function mentionsIn(html: string | null | undefined): MentionRef[] {
	if (html === null || html === undefined || html.trim() === '') return []
	const found: MentionRef[] = []
	converter({ onMention: (mention) => found.push(mention) }).turndown(html)
	return found
}

/** Rich text with its images and mentions as the HTML has them. */
const asRendered = converter({})

/**
 * Turns the HTML Jira and Confluence render their rich text to into Markdown for agents to read;
 * empty for none. Tables stay HTML: Markdown can't hold a table with lists or line breaks in its
 * cells, and agents read HTML tables fine. A mention of a person, a link to a profile the agent
 * can't open, is `` `@mention({ name: "Rita Reporter", email: "rita@example.com", id: "5b10" })` ``,
 * so an agent and a UI both tell who is meant.
 */
export function htmlToMarkdown(html: string | null | undefined, options?: RichTextOptions): string {
	if (html === null || html === undefined || html.trim() === '') return ''
	return (options === undefined ? asRendered : converter(options)).turndown(html).trim()
}
