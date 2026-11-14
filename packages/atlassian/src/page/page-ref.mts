import { PageId } from '../tools/page-tools.mts'

/** A page, by its id, its URL, or as collected. */
export type PageRef = string | { readonly id: string }

/** Where a page's id is in its URL: `/pages/12345/Title` on Cloud and in newer Data Center, `?pageId=12345` in older. */
const idInUrl = [/\/pages\/(\d+)(?:[/?#]|$)/, /[?&]pageId=(\d+)/]

/** The page's id, from an id or a page URL, or an error saying what to give instead. */
export function pageIdOf(page: PageRef): PageId {
	if (typeof page !== 'string') return PageId.parse(page.id)
	const trimmed = page.trim()
	if (PageId.safeParse(trimmed).success) return trimmed
	for (const pattern of idInUrl) {
		const id = pattern.exec(trimmed)?.[1]
		if (id !== undefined) return id
	}
	throw new Error(
		`${page} is neither a Confluence page id nor a page URL with one, such as https://example.atlassian.net/wiki/spaces/TEAM/pages/12345/Title.`,
	)
}
