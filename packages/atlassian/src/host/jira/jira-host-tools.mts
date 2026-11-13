import { createHash } from 'node:crypto'
import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { z } from 'zod'
import { commentOnIssue, getIssue, transitionIssue } from '../../tools/issue-tools.mts'
import { defaultIssueSearchLimit, searchIssues } from '../../tools/issue-search-tools.mts'
import { oneAtATime } from '../one-at-a-time.mts'
import { signed } from '../signature.mts'
import { markingTransient } from '../transient-error.mts'
import { issueData, issueUrl } from './issue-data.mts'
import type { JiraApi } from './jira-api.mts'

/** Hex digits of a comment key's hash in its property's name: enough that two keys of one issue never meet. */
const keyHashLength = 16

/** Where the connector keeps the id of one keyed comment: an issue property per key, named by a hash of the key. */
export function keyedCommentProperty(commentKey: string): string {
	return `mesh-flow.comment.${createHash('sha256').update(commentKey).digest('hex').slice(0, keyHashLength)}`
}

/** What a keyed comment's property holds: the key it was posted with, and the comment's id. */
const KeyedComment = z.object({ key: z.string(), id: z.string() })

/** The host halves of the Jira tools. */
export function jiraHostTools(api: JiraApi): HostTool[] {
	// Two comments with one key at once would both be posted: the second waits for the first.
	const oneCommentAtATime = oneAtATime()
	return [
		hostTool(getIssue, async ({ key }, context) => {
			const site = await api(context)
			return issueData(await markingTransient(() => site.issue(key, context.abortSignal)), site.url)
		}),

		hostTool(searchIssues, async ({ jql, limit = defaultIssueSearchLimit }, context) => {
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
			try {
				await markingTransient(() => site.moveIssue(key, leading.id, abortSignal))
			} catch (error) {
				// The move may have happened though its answer was lost: then the issue has the status.
				const after = await markingTransient(() => site.issue(key, abortSignal)).catch(() => undefined)
				if (!sameStatus(after?.fields.status?.name ?? '', status)) throw error
			}
			return { status: leading.to, moved: true }
		}),

		hostTool(commentOnIssue, async ({ key, body, commentKey }, context) => {
			const site = await api(context)
			const { abortSignal } = context
			const markdown = signed(body, context.runId)
			const posted = (id: string) => ({ id, url: `${issueUrl(site.url, key)}?focusedCommentId=${id}` })
			if (commentKey === undefined) return posted(await markingTransient(() => site.addComment(key, markdown, abortSignal)))
			const property = keyedCommentProperty(commentKey)
			return oneCommentAtATime(`${site.url} ${key} ${property}`, abortSignal, async () => {
				const recorded = KeyedComment.safeParse(await markingTransient(() => site.property(key, property, abortSignal)))
				const earlier = recorded.success && recorded.data.key === commentKey ? recorded.data.id : undefined
				if (earlier !== undefined && (await markingTransient(() => site.updateComment(key, earlier, markdown, abortSignal))))
					return posted(earlier)
				// No comment with this key yet, or a person deleted it: post a new one and remember it.
				const id = await markingTransient(() => site.addComment(key, markdown, abortSignal))
				await markingTransient(() => site.setProperty(key, property, { key: commentKey, id }, abortSignal))
				return posted(id)
			})
		}),
	]
}

/** Whether two status names are the same status: Jira compares them without regard to case. */
function sameStatus(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase()
}
