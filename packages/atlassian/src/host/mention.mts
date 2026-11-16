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

/** What reading a mention takes of a node: without the DOM's types, as the host has no DOM. */
export interface RenderedNode {
	readonly nodeName: string
	readonly textContent: string | null
	getAttribute(name: string): string | null
}

/** The classes Jira and Confluence give a link that mentions a person. */
const mentionClasses = ['user-hover', 'user-mention', 'confluence-userlink']

/** The page Data Center's Jira links a mention to, whose `rel` is the username. */
const profilePage = 'ViewProfile.jspa'

/** A base to parse a relative profile link against: only the link's path and query are read. */
const relativeLinkBase = 'https://site.invalid'

/** One key per person a mention can name, by account id, username or, without either, the name. */
export function mentionKey(mention: MentionRef): string {
	if (mention.accountId !== undefined) return `account:${mention.accountId}`
	return mention.username === undefined ? `name:${mention.name}` : `user:${mention.username}`
}

/** The account id or username a mention holds, which the site knows the person by. */
export function mentionIdOf(mention: MentionRef): string | undefined {
	return mention.accountId ?? mention.username
}

/** A mention as the link holds it, for a person the site wasn't asked about or couldn't tell about. */
export function linkedPerson(mention: MentionRef): Person {
	return { name: mention.name, id: mentionIdOf(mention) }
}

/** A person as an inline call, which reads as code in Markdown and parses back. Leaves out what isn't known. */
export function mentionText(person: Person): string {
	const fields = Object.entries({ name: person.name, email: person.email, id: person.id })
		.filter((field): field is [string, string] => field[1] !== undefined)
		// A backtick would end the code span the call is written in.
		.map(([name, value]) => `${name}: ${JSON.stringify(value).replaceAll('`', "'")}`)
	return `\`@mention({ ${fields.join(', ')} })\``
}

/**
 * The person a link mentions, or `undefined` for any other node. Jira and Confluence mark a
 * mention with a class, and put the account id (Cloud) or username (Data Center) in an attribute
 * or the profile link.
 */
export function mentionRefOf(node: RenderedNode): MentionRef | undefined {
	if (node.nodeName !== 'A') return undefined
	const classes = (node.getAttribute('class') ?? '').split(/\s+/)
	const accountId = node.getAttribute('data-account-id') ?? undefined
	if (accountId === undefined && !mentionClasses.some((name) => classes.includes(name))) return undefined
	const href = node.getAttribute('href') ?? ''
	const query = URL.parse(href, relativeLinkBase)?.searchParams
	const name = (node.textContent ?? '').trim().replace(/^@/, '')
	const onCloud = accountId ?? query?.get('accountId') ?? pathPart(/\/people\/([^/?#]+)/, href)
	if (onCloud !== undefined) return { name, accountId: onCloud }
	// Data Center's Jira puts the username in `rel` of a profile link; its Confluence in `data-username` or a `/~user` link.
	const username =
		node.getAttribute('data-username') ??
		query?.get('name') ??
		pathPart(/\/~([^/?#]+)/, href) ??
		(href.includes(profilePage) ? node.getAttribute('rel') : null)
	return username === null ? { name } : { name, username }
}

/** The part of a link's path `pattern` takes, decoded as query values are. */
function pathPart(pattern: RegExp, href: string): string | undefined {
	const part = pattern.exec(href)?.[1]
	if (part === undefined) return undefined
	try {
		return decodeURIComponent(part)
	} catch {
		return part
	}
}
