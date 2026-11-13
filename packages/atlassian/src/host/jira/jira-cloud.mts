import { createCloudClient, type ClientConfig } from 'jira.js'
import { markdownToAdf } from 'marklassian'
import { sentOnce } from '../host-options.mts'
import type { Download } from './attachments.mts'
import type { JiraSite } from './jira-site.mts'
import { issueFields, RawFoundIssue, RawIssue, searchFields } from './raw-issue.mts'
import { orWhenNotFound } from './when-not-found.mts'

/**
 * A Jira Cloud site, on its REST API v3. Comments go in as Atlassian Document Format, made from the
 * Markdown they're written in.
 */
export function jiraCloud(config: ClientConfig & { readonly host: string }, download: Download): JiraSite {
	const client = createCloudClient(config)
	// Requests that make something new are sent once: a retry after a lost answer would make it twice.
	const once = createCloudClient({ ...config, retry: sentOnce })
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
			const found = await client.issueSearch.searchIssuesPost({ jql, maxResults: limit, fields: searchFields }, { signal: abortSignal })
			const issues = (found.issues ?? []).map((issue) => RawFoundIssue.parse(issue))
			return { issues, more: found.isLast === false || typeof found.nextPageToken === 'string' }
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
			const comment = await once.issueComments.addComment({ issueIdOrKey: key, body: markdownToAdf(markdown) }, { signal: abortSignal })
			if (comment.id === undefined) throw new Error(`Jira added a comment to ${key} without an id.`)
			return comment.id
		},
		updateComment: (key, commentId, markdown, abortSignal) =>
			orWhenNotFound(async () => {
				await client.issueComments.updateComment(
					{ issueIdOrKey: key, id: commentId, body: { body: markdownToAdf(markdown) } },
					{ signal: abortSignal },
				)
				return true
			}, false),
		property: (key, name, abortSignal) =>
			orWhenNotFound(
				async () =>
					(await client.issueProperties.getIssueProperty({ issueIdOrKey: key, propertyKey: name }, { signal: abortSignal })).value,
				undefined,
			),
		async setProperty(key, name, value, abortSignal) {
			await client.issueProperties.setIssueProperty({ issueIdOrKey: key, propertyKey: name, body: value }, { signal: abortSignal })
		},
		// Who a mention names is worth one try: without an answer, the mention keeps what its link holds.
		async user({ accountId }, abortSignal) {
			if (accountId === undefined) return undefined
			const user = await once.users.getUser({ accountId }, { signal: abortSignal })
			return { name: user.displayName, email: user.emailAddress }
		},
		download,
	}
}
