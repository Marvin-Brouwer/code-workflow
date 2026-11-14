import J2M from 'jira2md'

/** A fenced code block, between backticks or tildes: its language, if it names one, and its lines. */
const fencedCode = /^(```|~~~)([\w+-]*)[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gm

/** A code span: what's between one backtick and the next on the line. */
const codeSpan = /`([^`\n]+)`/g

/** What wiki markup reads as formatting even inside `{{...}}`, and the backslash itself, so each is escaped with one in a code span. */
const wikiFormatting = /[\\*_+\-^~?{}[\]|]/g

/** What a placeholder starts with: letters only, which jira2md leaves alone. */
const placeholderPrefix = 'MESHFLOWCODE'

/** What stands in for a code block or span while the rest is converted: the prefix, its index and an `X`. */
const placeholder = (index: number) => `${placeholderPrefix}${String(index)}X`

/** Every placeholder in the converted text, with its index. */
const placeholders = new RegExp(`${placeholderPrefix}(\\d+)X`, 'g')

/**
 * Markdown as Jira Data Center's wiki markup. Code blocks and spans are taken out before jira2md
 * converts the rest and put back as `{code}` and `{{...}}` after, since jira2md would read the
 * `*` and `_` in them, such as in a glob like `*.mts`, as emphasis. In a span, what wiki markup
 * would still read as formatting is escaped.
 */
export function markdownToWiki(markdown: string): string {
	const code: string[] = []
	const keep = (wiki: string) => placeholder(code.push(wiki) - 1)
	const protectedMarkdown = markdown
		.replaceAll(fencedCode, (_block, _fence: string, language: string, lines: string) =>
			keep(`{code${language === '' ? '' : `:${language}`}}\n${lines}\n{code}`),
		)
		.replaceAll(codeSpan, (_span, text: string) => keep(`{{${text.replaceAll(wikiFormatting, '\\$&')}}}`))
	return J2M.to_jira(protectedMarkdown).replaceAll(placeholders, (_placeholder, index: string) => code[Number(index)] ?? '')
}
