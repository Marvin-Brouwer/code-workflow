import { tool, toPrompt, workspace, type ToolContext } from '@mesh-flow/core'
import { z } from 'zod'
import { stubs } from '../stubs.mts'
import type { PageData } from '../tools/page-tools.mts'
import { pageMarkdownOf } from './markdown.mts'
import { pageIdOf, type PageRef } from './page-ref.mts'

/** Where collected pages are dumped, for agents to read. */
const pagesFolder = workspace.folder('confluence', { description: 'the Confluence pages this run read, one Markdown file each' })

/** A collected page: what Confluence has, and its Markdown dump in the workspace, which is how it appears in a prompt. */
export interface ConfluencePage extends PageData {
	/** The dump, relative to the workspace. */
	readonly path: string
	/** The dump's absolute path, which is how it renders in a prompt. */
	[toPrompt](): string
}

/**
 * Collects a page, by its id or its URL: reads it from Confluence and writes it as Markdown into
 * `confluence/` in the workspace. In a prompt it renders as that file's absolute path.
 *
 * ```ts
 * const guidelines = await confluence.collect('https://example.atlassian.net/wiki/spaces/TEAM/pages/12345/Guidelines')
 * await developer.loop`Follow ${guidelines} while you work.`
 * ```
 */
export async function collect(page: PageRef, context?: ToolContext): Promise<ConfluencePage> {
	const data = await stubs.getPage({ id: pageIdOf(page) }, context)
	const file = workspace.file(`${pagesFolder.path}/${data.id}.md`)
	await file.write(pageMarkdownOf(data))
	const location = file.location()
	return Object.freeze({ ...data, path: file.path, [toPrompt]: () => location })
}

/** The agent's form of {@link collect}: dumps a page to Markdown in the workspace and returns the dump's absolute path. */
export const dump = tool('confluenceDump', {
	description: 'Writes a Confluence page, by its id or URL, as Markdown into the workspace and returns the file',
	input: z.object({ page: z.string().min(1).describe('The page id, or its URL') }),
	action: async ({ page }, context) => ({ path: (await collect(page, context))[toPrompt]() }),
})

/**
 * Searches Confluence pages by their text: a tool for agents, and a function for code. Returns ids,
 * titles, spaces and excerpts; `confluence.dump` reads one.
 */
export const search = stubs.searchPages
