import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import { commentOnIssue, getIssue, transitionIssue } from '../../tools/issue-tools.mts'
import { defaultSearchLimit, searchIssues } from '../../tools/search-tools.mts'
import { signed } from '../signature.mts'
import { markingTransient } from '../transient-error.mts'
import { issueData, issueUrl } from './issue-data.mts'
import type { JiraApi } from './jira-api.mts'

/**
 * The issue property the connector keeps the ids of its keyed comments in, `{ [key]: commentId }`:
 * how commenting again with the same key finds the comment to update, on Cloud and Data Center alike.
 */
export const keyedCommentsProperty = 'mesh-flow.comments'

const KeyedComments = z.record(z.string(), z.string()).catch({})

/** The host halves of the Jira tools. */
export function jiraHostTools(api: JiraApi): HostTool[] {
	return [
		hostTool(getIssue, async ({ key }, context) => {
			const site = await api(context)
			return issueData(await markingTransient(() => site.issue(key, context.abortSignal)), site.url)
		}),

		hostTool(searchIssues, async ({ jql, limit = defaultSearchLimit }, context) => {
			const site = await api(context)
			const found = await markingTransient(() => site.search(jql, limit, context.abortSignal))
			return {
				issues: found.issues.map((issue) => ({
					key: issue.key,
					summary: issue.fields.summary,
					status: issue.fields.status?.name ?? '',
					type: issue.fields.issuetype?.name ?? '',
					url: issueUrl(site.url, issue.key),
				})),
				more: found.more,
			}
		}),

		hostTool(transitionIssue, async ({ key, status }, context) => {
			const site = await api(context)
			const { abortSignal } = context
			const issue = await markingTransient(() => site.issue(key, abortSignal))
			const current = issue.fields.status?.name ?? ''
			if (sameStatus(current, status)) return { status: current, moved: false }
			const transitions = await markingTransient(() => site.transitions(key, abortSignal))
			const leading = transitions.find((transition) => sameStatus(transition.to, status))
			if (leading === undefined) {
				const reachable = transitions.map((transition) => transition.to).join(', ') || 'none'
				throw new Error(`${key} can't move from ${current} to ${status}. It can move to: ${reachable}.`)
			}
			await markingTransient(() => site.transition(key, leading.id, abortSignal))
			return { status: leading.to, moved: true }
		}),

		hostTool(commentOnIssue, async ({ key, body, commentKey }, context) => {
			const site = await api(context)
			const { abortSignal } = context
			const markdown = signed(body, context.runId)
			const posted = (id: string) => ({ id, url: `${issueUrl(site.url, key)}?focusedCommentId=${id}` })
			if (commentKey === undefined) return posted(await markingTransient(() => site.addComment(key, markdown, abortSignal)))
			const keyed = KeyedComments.parse((await markingTransient(() => site.property(key, keyedCommentsProperty, abortSignal))) ?? {})
			const earlier = keyed[commentKey]
			if (earlier !== undefined && (await markingTransient(() => site.updateComment(key, earlier, markdown, abortSignal))))
				return posted(earlier)
			// No comment with this key yet, or a person deleted it: post a new one and remember it.
			const id = await markingTransient(() => site.addComment(key, markdown, abortSignal))
			await markingTransient(() => site.setProperty(key, keyedCommentsProperty, { ...keyed, [commentKey]: id }, abortSignal))
			return posted(id)
		}),
	]
}

/** Whether two status names are the same status: Jira compares them without regard to case. */
function sameStatus(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase()
}
