import { stringify } from 'yaml'

/**
 * A Markdown document with its metadata as YAML frontmatter, between `---` lines, as editors and
 * static site tools read it, so an agent tells the facts of an issue or page from its text.
 */
export function withFrontmatter(metadata: Readonly<Record<string, unknown>>, body: string): string {
	return `---\n${stringify(metadata)}---\n\n${body}`
}
