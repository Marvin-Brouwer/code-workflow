import { hostTool, type HostTool } from '@mesh-flow/gateway'
import { splitRepositoryName } from '../repository-name.mts'
import { closeIssue, commentMarker, commentOnIssue, getIssue, labelIssue, type IssueData } from '../tools/issue-tools.mts'
import type { ApiClient } from './api.mts'

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
			const marked = key === undefined ? body : `${body}\n\n${commentMarker(key)}`
			if (key !== undefined) {
				const existing = await client.paginate(client.rest.issues.listComments, { ...where, per_page: 100 })
				const earlier = existing.find((comment) => comment.body?.includes(commentMarker(key)) === true)
				if (earlier !== undefined) {
					const { data } = await client.rest.issues.updateComment({ ...where, comment_id: earlier.id, body: marked })
					return { id: data.id, url: data.html_url }
				}
			}
			const { data } = await client.rest.issues.createComment({ ...where, body: marked })
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
