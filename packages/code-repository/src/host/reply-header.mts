/**
 * What ends the header a reply starts with, so what replies say is compared without it. Not one of
 * the connector's markers, which `unsigned` takes out: the header's end stays when a reply is edited.
 */
const headerEnd = '<!-- mesh-flow-header-end -->'

/**
 * `body` under `header`, which says what the reply answers, such as a quote of the item on a
 * conversation without threads. Without a header, just `body`.
 */
export function withHeader(header: string | undefined, body: string): string {
	return header === undefined || header === '' ? body : `${header}\n\n${headerEnd}\n\n${body}`
}

/**
 * What a reply says, without the header {@link withHeader} put above it. The header quotes the item
 * as it was when the reply was posted, so a reviewer's edit since doesn't make it a different reply.
 */
export function withoutHeader(text: string): string {
	const end = text.indexOf(headerEnd)
	return end === -1 ? text : text.slice(end + headerEnd.length).trimStart()
}
