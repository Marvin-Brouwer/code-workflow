/**
 * Takes the source indentation out of a template's literal parts. Prompts are written indented in
 * code; the agent shouldn't get that indentation. The parts are dedented together, so a line that
 * starts with an interpolation keeps its place, and interpolated text is never touched.
 *
 * Leading and trailing blank lines go too.
 */
export function dedentParts(parts: readonly string[]): string[] {
	// A placeholder that can't occur in source text, so the parts can be split apart again.
	const placeholder = '\u0000'
	const lines = parts.join(placeholder).split('\n')
	const indents = lines.filter((line) => line.trim() !== '').map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0)
	const indent = indents.length === 0 ? 0 : Math.min(...indents)
	const text = lines
		.map((line) => line.slice(Math.min(indent, /^[ \t]*/.exec(line)?.[0].length ?? 0)))
		.join('\n')
		.replace(/^\s*\n/, '')
		.replace(/\n\s*$/, '')
	return text.split(placeholder)
}
