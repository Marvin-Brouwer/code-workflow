/** What every marker a connector leaves in a comment starts with. */
export const markerStart = '<!-- mesh-flow:'

/** Mixed into a comment's body to find it again, so posting it twice updates it instead. */
export function commentMarker(key: string): string {
	return `${markerStart}${key} -->`
}

/** What marker `name:<value>` in a comment's body holds, if the body has one: the last one, which the connector wrote last. */
export function markerValue(body: string, name: string): string | undefined {
	const start = `${markerStart}${name}:`
	const from = body.lastIndexOf(start)
	if (from === -1) return undefined
	const end = body.indexOf(' -->', from + start.length)
	return end === -1 ? undefined : body.slice(from + start.length, end)
}

/** Whether a comment's body carries a marker: a connector wrote it, so it isn't a reviewer's. */
export function isMarked(body: string | null | undefined): boolean {
	return body?.includes(markerStart) ?? false
}
