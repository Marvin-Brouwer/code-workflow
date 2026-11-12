import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { splitRepositoryName } from '../repository-name.mts'
import { closeIssue, commentMarker, commentOnIssue, getIssue, labelIssue, type IssueData } from '../tools/issue-tools.mts'
import { pageSize, type ApiClient } from './api.mts'
import { signed } from '@mesh-flow/forge/host'

/**
 * The marker key of a comment posted without a key, which is never looked up to update. A caller's
 * key gets its own prefix, `key:`, so it never matches this one or the connector's other markers.
 */
const unkeyed = 'comment'

/** The marker key of a comment posted with `key`. */
const keyed = (key: string) => `key:${key}`

/** The host halves of the issue tools. */
export function issueHostTools(api: ApiClient): HostTool[] {
	return [
		hostTool(getIssue, async ({ repository, number }, context): Promise<IssueData> => {
			const client = await api(context)
			const { data } = await client.rest.issues.get({ ...splitRepositoryName(repository), issue_number: number })
			return {
				repository,
				number: data.number,
				title: data.title,
				body: data.body ?? '',
				state: data.state === 'closed' ? 'closed' : 'open',
				labels: data.labels.map((label) => (typeof label === 'string' ? label : (label.name ?? ''))).filter((name) => name !== ''),
				author: data.user?.login ?? '',
				url: data.html_url,
				createdAt: data.created_at,
			}
		}),

		hostTool(commentOnIssue, async ({ repository, number, body, key }, context) => {
			const client = await api(context)
			const where = { ...splitRepositoryName(repository), issue_number: number }
			// Marked also without a key: the marker is how a look at a review tells the run's own comments from a reviewer's.
			const signedBody = signed(body, context.runId, [key === undefined ? unkeyed : keyed(key)])
			if (key !== undefined) {
				const existing = await client.paginate(client.rest.issues.listComments, { ...where, per_page: pageSize })
				const earlier = existing.find((comment) => comment.body?.includes(commentMarker(keyed(key))) === true)
				if (earlier !== undefined) {
					const { data } = await client.rest.issues.updateComment({ ...where, comment_id: earlier.id, body: signedBody })
					return { id: data.id, url: data.html_url }
				}
			}
			const { data } = await client.rest.issues.createComment({ ...where, body: signedBody })
			return { id: data.id, url: data.html_url }
		}),

		hostTool(labelIssue, async ({ repository, number, labels }, context) => {
			const client = await api(context)
			const { data } = await client.rest.issues.addLabels({ ...splitRepositoryName(repository), issue_number: number, labels })
			return { labels: data.map((label) => label.name) }
		}),

		hostTool(closeIssue, async ({ repository, number }, context) => {
			const client = await api(context)
			const { data } = await client.rest.issues.update({ ...splitRepositoryName(repository), issue_number: number, state: 'closed' })
			return { state: data.state === 'closed' ? 'closed' : 'open' }
		}),
	]
}
