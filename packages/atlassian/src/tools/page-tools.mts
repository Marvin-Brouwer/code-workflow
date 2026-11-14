import { z } from 'zod'

/** A Confluence page id: its number, as in `/pages/12345/` in its URL. */
export const PageId = z.string().regex(/^[1-9]\d*$/, 'Use a Confluence page id, the number in its URL.')
export type PageId = z.infer<typeof PageId>

/** A page as Confluence has it, its body as Markdown. */
export const PageData = z.object({
	id: PageId,
	title: z.string(),
	space: z.string(),
	url: z.url(),
	version: z.int().nonnegative(),
	updated: z.string(),
	body: z.string(),
})
export type PageData = z.infer<typeof PageData>

/** Reads a page on the host. */
export const getPage = {
	name: 'confluencePage',
	description: 'Reads a Confluence page',
	input: z.object({ id: PageId }),
	output: PageData,
}

/** The most pages a search hands back when it isn't told. */
export const defaultPageSearchLimit = 20

/** The most pages one search hands back. */
export const maxPageSearchLimit = 50

/** A page a search found. */
export const FoundPage = z.object({
	id: PageId,
	title: z.string(),
	space: z.string(),
	url: z.url(),
	excerpt: z.string(),
})
export type FoundPage = z.infer<typeof FoundPage>

/** Searches pages by their text on the host. */
export const searchPages = {
	name: 'confluenceSearch',
	description: 'Searches Confluence pages by their text. Returns their ids, titles, spaces and an excerpt; read one with the dump tool.',
	input: z.object({
		text: z.string().min(1).describe('The words to look for'),
		space: z.string().min(1).optional().describe('Only pages in the space with this key'),
		limit: z
			.int()
			.min(1)
			.max(maxPageSearchLimit)
			.optional()
			.describe(`The most pages to return. Default: ${String(defaultPageSearchLimit)}.`),
	}),
	output: z.object({
		pages: z.array(FoundPage),
		more: z.boolean().describe('Whether more pages match than were returned'),
	}),
}
