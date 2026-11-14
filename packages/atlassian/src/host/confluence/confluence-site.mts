import type { UserLookup } from '../people.mts'
import type { RawPage, RawSearch } from './raw-page.mts'

/** A Confluence site for one call. */
export interface ConfluenceSite {
	/** Where pages are opened, for links: the site with `/wiki` on Cloud. */
	readonly url: string
	/** Reads a page, with its rendered body, space and version. */
	readonly page: (id: string, abortSignal: AbortSignal) => Promise<RawPage>
	/** Searches pages with CQL, with each result's space and highlighted excerpt. */
	readonly search: (cql: string, limit: number, abortSignal: AbortSignal) => Promise<RawSearch>
	/** Who a mention names, by account id on Cloud and username on Data Center. */
	readonly user: UserLookup
}
