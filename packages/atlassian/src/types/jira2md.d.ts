/** jira2md ships no types: the one function this package uses. */
declare module 'jira2md' {
	const J2M: {
		/** Markdown as Jira wiki markup. */
		readonly to_jira: (markdown: string) => string
	}
	export default J2M
}
