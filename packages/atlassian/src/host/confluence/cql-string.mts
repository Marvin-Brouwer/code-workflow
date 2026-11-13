/** A string as CQL takes it: in double quotes, with quotes and backslashes in it escaped. */
export function cqlString(value: string): string {
	return `"${value.replaceAll(/["\\]/g, '\\$&')}"`
}

/** The CQL that finds pages with `text` in them, in `space` when one is given. */
export function pageSearchCql(text: string, space: string | undefined): string {
	return ['type = page', `text ~ ${cqlString(text)}`, ...(space === undefined ? [] : [`space = ${cqlString(space)}`])].join(' AND ')
}
