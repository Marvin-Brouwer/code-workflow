import { stringify } from 'yaml'

/**
 * A Markdown document with its metadata as YAML frontmatter, between `---` lines, as editors and
 * static site tools read it, so an agent tells the facts of an issue or page from its text. Written
 * as YAML 1.1, so a value such as a time or `yes` is quoted and reads back as text, whichever YAML
 * version the reader speaks.
 */
export function withFrontmatter(metadata: Readonly<Record<string, unknown>>, body: string): string {
	return `---\n${stringify(metadata, { version: '1.1' })}---\n\n${body}`
}
