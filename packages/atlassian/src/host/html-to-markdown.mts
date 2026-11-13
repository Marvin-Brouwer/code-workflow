import TurndownService from 'turndown'

/** A person a mention in rich text names: as the link says, before the site is asked who it is. */
export interface MentionRef {
	readonly name: string
	/** The account id, on Cloud. */
	readonly accountId?: string | undefined
	/** The username, on Data Center. */
	readonly username?: string | undefined
}

/** A mentioned person as the Markdown names them: `id` is the account id or username, which a later mention back can use. */
export interface Person {
	readonly name: string
	readonly email?: string | undefined
	readonly id?: string | undefined
}

/** How rich text becomes Markdown: where its images point, and who its mentions are. */
export interface RichTextOptions {
	/** Where an image in the Markdown points, for where it pointed in the HTML. Default: where it did. */
	readonly imageSource?: (src: string) => string
	/** Who a mention names. Default: the name and id the link holds. */
	readonly person?: (mention: MentionRef) => Person
}

/** What the rules read of a node: without the DOM's types, as the host has no DOM. */
interface RenderedNode {
	readonly nodeName: string
	readonly textContent: string | null
	getAttribute(name: string): string | null
}

/** The classes Jira and Confluence give a link that mentions a person. */
const mentionClasses = ['user-hover', 'user-mention', 'confluence-userlink']

/**
 * Turns the HTML Jira and Confluence render their rich text to into Markdown for agents to read.
 * Tables stay HTML: Markdown can't hold a table with lists or line breaks in its cells, and agents
 * read HTML tables fine. A mention of a person, a link to a profile the agent can't open, is
 * `` `@mention({ name: "Rita Reporter", email: "rita@example.com", id: "5b10" })` ``, so an agent and
 * a UI both tell who is meant.
 */
function converter({ imageSource = (src) => src, person = personOf }: RichTextOptions): TurndownService {
	return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' })
		.keep(['table'])
		.addRule('mention', {
			filter: (node: RenderedNode) => mentionRefOf(node) !== undefined,
			replacement: (_content, node: RenderedNode) => {
				const mention = mentionRefOf(node)
				return mention === undefined ? '' : mentionText(person(mention))
			},
		})
		.addRule('image', {
			filter: 'img',
			replacement: (_content, node: RenderedNode) => {
				const src = node.getAttribute('src') ?? ''
				return src === '' ? '' : `![${node.getAttribute('alt') ?? ''}](${imageSource(src)})`
			},
		})
}

/** Rich text with its images and mentions as the HTML has them. */
const asRendered = converter({})

/** A mention as the link holds it, before the site is asked: its name, and the id or username in it. */
function personOf(mention: MentionRef): Person {
	return { name: mention.name, id: mention.accountId ?? mention.username }
}

/** A person as an inline call, which reads as code in Markdown and parses back. Leaves out what isn't known. */
export function mentionText(person: Person): string {
	const fields = Object.entries({ name: person.name, email: person.email, id: person.id })
		.filter((field): field is [string, string] => field[1] !== undefined)
		.map(([name, value]) => `${name}: ${JSON.stringify(value).replaceAll('`', "'")}`)
	return `\`@mention({ ${fields.join(', ')} })\``
}

/**
 * The person a link mentions, or `undefined` for any other node. Jira and Confluence mark a
 * mention with a class, and put the account id (Cloud) or username (Data Center) in an attribute
 * or the profile link.
 */
function mentionRefOf(node: RenderedNode): MentionRef | undefined {
	if (node.nodeName !== 'A') return undefined
	const classes = (node.getAttribute('class') ?? '').split(/\s+/)
	const accountId = node.getAttribute('data-account-id') ?? undefined
	if (accountId === undefined && !mentionClasses.some((name) => classes.includes(name))) return undefined
	const href = node.getAttribute('href') ?? ''
	const query = URL.parse(href, 'https://site.invalid')?.searchParams
	const name = (node.textContent ?? '').trim().replace(/^@/, '')
	const onCloud = accountId ?? query?.get('accountId') ?? /\/people\/([^/?#]+)/.exec(href)?.[1]
	if (onCloud !== undefined) return { name, accountId: onCloud }
	// Data Center's Jira puts the username in `rel`; its Confluence in `data-username` or a `/~user` link.
	const username = node.getAttribute('data-username') ?? query?.get('name') ?? /\/~([^/?#]+)/.exec(href)?.[1] ?? node.getAttribute('rel')
	return username === null ? { name } : { name, username }
}

/** The mentions in rendered rich text, as the links hold them, so the site can be asked who each is first. */
export function mentionsIn(html: string | null | undefined): MentionRef[] {
	if (html === null || html === undefined || html.trim() === '') return []
	const found: MentionRef[] = []
	converter({
		person: (mention) => {
			found.push(mention)
			return personOf(mention)
		},
	}).turndown(html)
	return found
}

/** Markdown for rendered rich text; empty for none. */
export function htmlToMarkdown(html: string | null | undefined, options?: RichTextOptions): string {
	if (html === null || html === undefined || html.trim() === '') return ''
	return (options === undefined ? asRendered : converter(options)).turndown(html).trim()
}
