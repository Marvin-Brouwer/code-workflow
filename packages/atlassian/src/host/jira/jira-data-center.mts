import { createServerClient, isNotFoundError, type ServerClientConfig } from 'jira.js'
import J2M from 'jira2md'
import type { JiraSite } from './jira-site.mts'
import { issueFields, RawFoundIssue, RawIssue, searchFields } from './raw-issue.mts'

/**
 * A Jira Data Center site, on its REST API v2. Comments go in as wiki markup, made from the
 * Markdown they're written in, since Data Center has no Atlassian Document Format.
 */
export function jiraDataCenter(config: ServerClientConfig & { readonly host: string }): JiraSite {
	const client = createServerClient(config)
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
		async transition(key, transitionId, abortSignal) {
			await client.issues.doTransition({ issueIdOrKey: key, transition: { id: transitionId } }, { signal: abortSignal })
		},
		async addComment(key, markdown, abortSignal) {
			const comment = await client.issues.addComment({ issueIdOrKey: key, body: J2M.to_jira(markdown) }, { signal: abortSignal })
			if (comment.id === undefined) throw new Error(`Jira added a comment to ${key} without an id.`)
			return comment.id
		},
		async updateComment(key, commentId, markdown, abortSignal) {
			try {
				await client.issues.updateComment(
					{ issueIdOrKey: key, id: commentId, body: { body: J2M.to_jira(markdown) } },
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
				return (await client.issues.getIssueProperty({ issueIdOrKey: key, propertyKey: name }, { signal: abortSignal })).value
			} catch (error) {
				if (isNotFoundError(error)) return undefined
				throw error
			}
		},
		async setProperty(key, name, value, abortSignal) {
			await client.issues.setIssueProperty({ issueIdOrKey: key, propertyKey: name, body: value }, { signal: abortSignal })
		},
	}
}
