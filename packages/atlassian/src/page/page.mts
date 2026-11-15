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
 * `confluence/<id>.md` in the workspace, with its title, URL, space, version and when it was last
 * updated as frontmatter. A mention reads as `` `@mention({ name, email, id })` ``, without the
 * email when the site keeps it private. The whole of what an agent reads is in
 * `test/confluence.spec.md` in the repository:
 * https://github.com/Marvin-Brouwer/code-workflow/blob/main/packages/atlassian/test/confluence.spec.md
 *
 * Collecting a page again writes it again, as it is in Confluence by then. Runs on the host,
 * through the gateway, so the token never reaches the sandbox.
 *
 * In a prompt the result renders as the Markdown file's absolute path. In code, its fields are what
 * Confluence has.
 *
 * @param page - The page's id, such as `12345`; its URL, as Cloud and Data Center show it
 * (`.../pages/12345/Title` or `...?pageId=12345`); or anything with an `id`, such as a page found
 * with `confluence.search`.
 * @param context - Leave it out in workflow code, where the run's signal stops the call. Pass the
 * context a tool's action got when you call this from a tool of your own.
 * @returns The page, with `path` the Markdown file relative to the workspace.
 * @throws When `page` is neither an id nor a page URL; when Confluence has no such page, or the token
 * can't read it.
 *
 * @example From code
 * ```ts
 * const guidelines = await confluence.collect('https://example.atlassian.net/wiki/spaces/TEAM/pages/12345/Guidelines')
 * const version = String(guidelines.version)
 * await jira.comment(story, `Follows [${guidelines.title}](${guidelines.url}), version ${version}.`, { key: 'guidelines' })
 * ```
 *
 * @example In a prompt
 * ```ts
 * const guidelines = await confluence.collect('12345')
 * await developer.loop`Implement ${story} in ${repository}. Follow ${guidelines} while you work.`
 * ```
 */
export async function collect(page: PageRef, context?: ToolContext): Promise<ConfluencePage> {
	const data = await stubs.getPage({ id: pageIdOf(page) }, context)
	const file = workspace.file(`${pagesFolder.path}/${data.id}.md`)
	await file.write(pageMarkdownOf(data))
	const location = file.location()
	return Object.freeze({ ...data, path: file.path, [toPrompt]: () => location })
}

/**
 * The agent's form of {@link collect}: dumps a page to Markdown in the workspace and returns
 * `{ path }`, the dump's absolute path, for an agent that found the page with `confluence.search`
 * or in a link. Code that wants the page's fields calls `confluence.collect` instead.
 *
 * Input: `{ page }`, the page's id or its URL.
 *
 * @throws When `page` is neither an id nor a page URL, and when Confluence has no such page, or the
 * token can't read it.
 *
 * @example From code
 * ```ts
 * const { path } = await confluence.dump({ page: '12345' })
 * ```
 *
 * @example For an agent
 * ```ts
 * await researcher.loop`Research ${story}. Read the pages it links to with ${confluence.dump}.`
 * ```
 */
export const dump = tool('confluenceDump', {
	description: 'Writes a Confluence page, by its id or URL, as Markdown into the workspace and returns the file',
	input: z.object({ page: z.string().min(1).describe('The page id, or its URL') }),
	action: async ({ page }, context) => ({ path: (await collect(page, context))[toPrompt]() }),
})

/**
 * Searches Confluence pages by their text: a tool for agents, and a function for code. Returns each
 * page's id, title, space, URL and an excerpt of where the words are, and whether more pages match
 * than came back; `confluence.dump` and `confluence.collect` read one in full.
 *
 * Input: `{ text, space?, limit? }`. `text` is the words to look for; `space` keeps the search to
 * the space with that key, such as `TEAM`; `limit` is how many pages come back, 20 by default and
 * 50 at most. Only pages are searched, not blog posts, comments or attachments.
 *
 * @throws When Confluence turns the search down.
 *
 * @example From code
 * ```ts
 * const { pages } = await confluence.search({ text: 'release process', space: 'TEAM', limit: 5 })
 * const [first] = pages
 * const releaseProcess = first === undefined ? undefined : await confluence.collect(first)
 * ```
 *
 * @example For an agent
 * ```ts
 * await researcher.loop`Research ${story}. Find the team's guidelines with ${confluence.search} and read them with ${confluence.dump}.`
 * ```
 */
export const search = stubs.searchPages
