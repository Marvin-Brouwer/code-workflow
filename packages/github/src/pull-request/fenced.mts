/** The shortest fence around a file or a text in a prompt: longer than what Markdown needs for a code block. */
const shortestFence = 5

/** `text` in a fence for a prompt, longer than any run of backticks the text holds, so the text can't close it. */
export function fenced(text: string): string {
	const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length))
	const fence = '`'.repeat(Math.max(shortestFence, longestRun + 1))
	return `${fence}\n${text.trimEnd()}\n${fence}`
}
