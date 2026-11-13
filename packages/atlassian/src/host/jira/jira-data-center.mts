import { createServerClient, type ServerClientConfig } from 'jira.js'
import { sentOnce } from '../host-options.mts'
import type { JiraSite } from './jira-site.mts'
import { markdownToWiki } from './markdown-to-wiki.mts'
import { issueFields, RawFoundIssue, RawIssue, searchFields } from './raw-issue.mts'
import { orWhenNotFound } from './when-not-found.mts'

/**
 * A Jira Data Center site, on its REST API v2. Comments go in as wiki markup, made from the
 * Markdown they're written in, since Data Center has no Atlassian Document Format.
 */
export function jiraDataCenter(config: ServerClientConfig & { readonly host: string }): JiraSite {
	const client = createServerClient(config)
	// Requests that make something new are sent once: a retry after a lost answer would make it twice.
	const once = createServerClient({ ...config, retry: sentOnce })
	return {
		url: config.host,
		async issue(key, abortSignal) {
			const issue = await client.issues.getIssue(
				{ issueIdOrKey: key, fields: issueFields, expand: 'renderedFields' },
				{ signal: abortSignal },
			)
			return RawIssue.parse(issue)
		},
		async search(jql, limit, abortSignal) {
			const found = await client.issueSearch.search({ jql, maxResults: limit, fields: searchFields }, { signal: abortSignal })
			const issues = (found.issues ?? []).map((issue) => RawFoundIssue.parse(issue))
			return { issues, more: (found.total ?? 0) > issues.length }
		},
		async transitions(key, abortSignal) {
			const { transitions = [] } = await client.issues.getTransitions({ issueIdOrKey: key }, { signal: abortSignal })
			return transitions.flatMap((transition) =>
				transition.id === undefined || transition.to?.name === undefined ? [] : [{ id: transition.id, to: transition.to.name }],
			)
		},
		async moveIssue(key, transitionId, abortSignal) {
			await once.issues.doTransition({ issueIdOrKey: key, transition: { id: transitionId } }, { signal: abortSignal })
		},
		async addComment(key, markdown, abortSignal) {
			const comment = await once.issues.addComment({ issueIdOrKey: key, body: markdownToWiki(markdown) }, { signal: abortSignal })
			if (comment.id === undefined) throw new Error(`Jira added a comment to ${key} without an id.`)
			return comment.id
		},
		updateComment: (key, commentId, markdown, abortSignal) =>
			orWhenNotFound(async () => {
				await client.issues.updateComment(
					{ issueIdOrKey: key, id: commentId, body: { body: markdownToWiki(markdown) } },
					{ signal: abortSignal },
				)
				return true
			}, false),
		property: (key, name, abortSignal) =>
			orWhenNotFound(
				async () => (await client.issues.getIssueProperty({ issueIdOrKey: key, propertyKey: name }, { signal: abortSignal })).value,
				undefined,
			),
		async user({ username }, abortSignal) {
			if (username === undefined) return undefined
			const user = await client.users.getUser({ username }, { signal: abortSignal })
			return { name: user.displayName, email: user.emailAddress }
		},
		async setProperty(key, name, value, abortSignal) {
			await client.issues.setIssueProperty({ issueIdOrKey: key, propertyKey: name, body: value }, { signal: abortSignal })
		},
	}
}
