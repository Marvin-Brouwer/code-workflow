import type { UserLookup } from '../people.mts'
import type { RawFoundIssue, RawIssue } from './raw-issue.mts'

/** A transition of an issue's workflow, and the status it leads to. */
export interface Transition {
	readonly id: string
	readonly to: string
}

/**
 * What the Jira host tools need from a site, whether it runs on Cloud or Data Center: the two
 * speak different API versions and rich text formats, so each has its own implementation.
 */
export interface JiraSite {
	/** The site's URL, for links to issues. */
	readonly url: string
	/** Reads an issue, with its rendered fields. */
	readonly issue: (key: string, abortSignal: AbortSignal) => Promise<RawIssue>
	/** Searches issues with JQL, up to `limit`, and says whether more match. */
	readonly search: (
		jql: string,
		limit: number,
		abortSignal: AbortSignal,
	) => Promise<{ readonly issues: readonly RawFoundIssue[]; readonly more: boolean }>
	/** The transitions the issue's workflow offers from its current status. */
	readonly transitions: (key: string, abortSignal: AbortSignal) => Promise<readonly Transition[]>
	/** Moves the issue through one of its transitions. */
	readonly moveIssue: (key: string, transitionId: string, abortSignal: AbortSignal) => Promise<void>
	/** Adds a comment written in Markdown, and resolves to its id. */
	readonly addComment: (key: string, markdown: string, abortSignal: AbortSignal) => Promise<string>
	/** Replaces a comment's body with Markdown. Resolves to false when the comment is gone. */
	readonly updateComment: (key: string, commentId: string, markdown: string, abortSignal: AbortSignal) => Promise<boolean>
	/** An issue property's value, or `undefined` when the issue has none by that name. */
	readonly property: (key: string, name: string, abortSignal: AbortSignal) => Promise<unknown>
	/** Who a mention names, by account id on Cloud and username on Data Center. */
	readonly user: UserLookup
	/** Sets an issue property, replacing its value. */
	readonly setProperty: (key: string, name: string, value: Record<string, unknown>, abortSignal: AbortSignal) => Promise<void>
}
