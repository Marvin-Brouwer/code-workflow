import { z } from 'zod'

/** The links Confluence puts next to what it answers: where a page opens, and the next page of results. */
const Links = z.object({ webui: z.string().optional(), next: z.string().optional() }).default({})
type Links = z.infer<typeof Links>

/** A page as REST API v1 has it, which Cloud and Data Center share. */
export const RawPage = z.object({
	id: z.string(),
	title: z.string(),
	space: z.object({ key: z.string() }).nullish(),
	version: z.object({ number: z.int(), when: z.string().default('') }).nullish(),
	body: z.object({ view: z.object({ value: z.string() }).nullish() }).nullish(),
	// Named as Confluence names it; `linksOf` reads it.
	_links: Links,
})
export type RawPage = z.infer<typeof RawPage>

/**
 * A page of search results as REST API v1's `/search` has it: each result holds its page under
 * `content`, with the excerpt next to it, where the words it matched are highlighted.
 */
export const RawSearch = z.object({
	results: z.array(z.object({ content: RawPage, excerpt: z.string().nullish() })),
	_links: Links,
})
export type RawSearch = z.infer<typeof RawSearch>

/** The links of a page or of a page of search results. */
export function linksOf(answer: { readonly _links: Links }): Links {
	return answer['_links']
}
