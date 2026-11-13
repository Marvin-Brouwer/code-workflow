import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { defaultPageSearchLimit, getPage, searchPages } from '../../tools/page-tools.mts'
import { htmlToMarkdown } from '../html-to-markdown.mts'
import { mentionKey, peopleIn } from '../people.mts'
import { markingTransient } from '../transient-error.mts'
import type { ConfluenceApi } from './confluence-api.mts'
import { pageSearchCql } from './cql-string.mts'
import { linksOf, type RawPage } from './raw-page.mts'

/** What Confluence wraps the words a search matched in, in an excerpt. */
const highlightMarkers = /@@@(?:end)?hl@@@/g

/** The host halves of the Confluence tools. */
export function confluenceHostTools(api: ConfluenceApi): HostTool[] {
	return [
		hostTool(getPage, async ({ id }, context) => {
			const site = await api(context)
			const page = await markingTransient(() => site.page(id, context.abortSignal))
			const html = page.body?.view?.value
			const people = await peopleIn([html], site.user, context.abortSignal)
			return {
				id: page.id,
				title: page.title,
				space: page.space?.key ?? '',
				url: pageUrl(site.url, page),
				version: page.version?.number ?? 0,
				updated: page.version?.when ?? '',
				body: htmlToMarkdown(html, { person: (mention) => people.get(mentionKey(mention)) ?? { name: mention.name } }),
			}
		}),

		hostTool(searchPages, async ({ text, space, limit = defaultPageSearchLimit }, context) => {
			const site = await api(context)
			const cql = pageSearchCql(text, space)
			const found = await markingTransient(() => site.search(cql, limit, context.abortSignal))
			return {
				pages: found.results.map(({ content: page, excerpt }) => ({
					id: page.id,
					title: page.title,
					space: page.space?.key ?? '',
					url: pageUrl(site.url, page),
					excerpt: (excerpt ?? '').replaceAll(highlightMarkers, '').trim(),
				})),
				more: linksOf(found).next !== undefined,
			}
		}),
	]
}

/** Where a person opens a page: the link Confluence gives, or the page's id when it gives none. */
function pageUrl(siteUrl: string, page: RawPage): string {
	return `${siteUrl}${linksOf(page).webui ?? `/pages/viewpage.action?pageId=${page.id}`}`
}
