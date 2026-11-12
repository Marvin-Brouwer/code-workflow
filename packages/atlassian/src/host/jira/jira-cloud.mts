import { createCloudClient, isNotFoundError, type ClientConfig } from 'jira.js'
import { markdownToAdf } from 'marklassian'
import type { JiraSite } from './jira-site.mts'
import { issueFields, RawFoundIssue, RawIssue, searchFields } from './raw-issue.mts'

/**
 * A Jira Cloud site, on its REST API v3. Comments go in as Atlassian Document Format, made from the
 * Markdown they're written in.
 */
export function jiraCloud(config: ClientConfig & { readonly host: string }): JiraSite {
	const client = createCloudClient(config)
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
			return { issues, more: found.isLast === false || (found.nextPageToken ?? undefined) !== undefined }
		},
		async transitions(key, abortSignal) {
			const { transitions = [] } = await client.issues.getTransitions({ issueIdOrKey: key }, { signal: abortSignal })
			return transitions.flatMap((transition) =>
				transition.id === undefined || transition.to?.name === undefined ? [] : [{ id: transition.id, to: transition.to.name }],
			)
		},
		async transition(key, transitionId, abortSignal) {
			await client.issues.doTransition({ issueIdOrKey: key, transition: { id: transitionId } }, { signal: abortSignal })
		},
		async addComment(key, markdown, abortSignal) {
			const comment = await client.issueComments.addComment({ issueIdOrKey: key, body: markdownToAdf(markdown) }, { signal: abortSignal })
			if (comment.id === undefined) throw new Error(`Jira added a comment to ${key} without an id.`)
			return comment.id
		},
		async updateComment(key, commentId, markdown, abortSignal) {
			try {
				await client.issueComments.updateComment(
					{ issueIdOrKey: key, id: commentId, body: { body: markdownToAdf(markdown) } },
					{ signal: abortSignal },
				)
				return true
			} catch (error) {
				if (isNotFoundError(error)) return false
				throw error
			}
		},
		async property(key, name, abortSignal) {
			try {
				return (await client.issueProperties.getIssueProperty({ issueIdOrKey: key, propertyKey: name }, { signal: abortSignal })).value
			} catch (error) {
				if (isNotFoundError(error)) return undefined
				throw error
			}
		},
		async setProperty(key, name, value, abortSignal) {
			await client.issueProperties.setIssueProperty({ issueIdOrKey: key, propertyKey: name, body: value }, { signal: abortSignal })
		},
	}
}
