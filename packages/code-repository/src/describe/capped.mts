/** How much of one listing or file goes into a prompt: a template, a lint setting or a commit log is far smaller. */
const maxPromptCharacters = 16_000

/** `text` as the prompt takes it: cut off past {@link maxPromptCharacters}, with `note` saying what follows. */
export function capped(text: string, note: string): string {
	if (text.length <= maxPromptCharacters) return text
	return `${text.slice(0, maxPromptCharacters)}\n(cut off here: ${note})`
}
