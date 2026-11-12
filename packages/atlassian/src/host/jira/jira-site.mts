import type { RawFoundIssue, RawIssue } from './raw-issue.mts'

/** A transition of an issue's workflow, and the status it leads to. */
export interface RawTransition {
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
	readonly issue: (key: string, abortSignal: AbortSignal) => Promise<RawIssue>
	readonly search: (
		jql: string,
		limit: number,
		abortSignal: AbortSignal,
	) => Promise<{ readonly issues: readonly RawFoundIssue[]; readonly more: boolean }>
	readonly transitions: (key: string, abortSignal: AbortSignal) => Promise<readonly RawTransition[]>
	readonly transition: (key: string, transitionId: string, abortSignal: AbortSignal) => Promise<void>
	/** Adds a comment written in Markdown, and resolves to its id. */
	readonly addComment: (key: string, markdown: string, abortSignal: AbortSignal) => Promise<string>
	/** Replaces a comment's body with Markdown. Resolves to false when the comment is gone. */
	readonly updateComment: (key: string, commentId: string, markdown: string, abortSignal: AbortSignal) => Promise<boolean>
	/** An issue property's value, or `undefined` when the issue has none by that name. */
	readonly property: (key: string, name: string, abortSignal: AbortSignal) => Promise<unknown>
	readonly setProperty: (key: string, name: string, value: Record<string, unknown>, abortSignal: AbortSignal) => Promise<void>
}
