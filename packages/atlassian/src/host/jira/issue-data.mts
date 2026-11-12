import type { IssueData, IssueLink, RelatedIssue } from '../../tools/issue-tools.mts'
import { htmlToMarkdown } from '../html-to-markdown.mts'
import type { NestedIssue, RawIssue } from './raw-issue.mts'

/** An issue as the sandbox gets it, from what Jira answered: its rich text as Markdown. */
export function issueData(raw: RawIssue, siteUrl: string): IssueData {
	const { fields, renderedFields } = raw
	const renderedComments = new Map((renderedFields.comment?.comments ?? []).map((comment) => [comment.id, comment.body]))
	return {
		key: raw.key,
		url: issueUrl(siteUrl, raw.key),
		summary: fields.summary,
		type: fields.issuetype?.name ?? '',
		status: fields.status?.name ?? '',
		priority: fields.priority?.name ?? null,
		assignee: fields.assignee?.displayName ?? null,
		reporter: fields.reporter?.displayName ?? null,
		labels: fields.labels,
		components: fields.components.map((component) => component.name),
		parent: fields.parent === null || fields.parent === undefined ? null : related(fields.parent),
		created: fields.created,
		updated: fields.updated,
		description: htmlToMarkdown(renderedFields.description),
		comments: (fields.comment?.comments ?? []).map((comment) => ({
			id: comment.id,
			author: comment.author?.displayName ?? 'unknown',
			created: comment.created,
			body: htmlToMarkdown(renderedComments.get(comment.id)),
		})),
		links: fields.issuelinks.flatMap((link): IssueLink[] => {
			if (link.outwardIssue !== undefined) return [{ ...related(link.outwardIssue), relation: link.type.outward }]
			if (link.inwardIssue !== undefined) return [{ ...related(link.inwardIssue), relation: link.type.inward }]
			return []
		}),
		subtasks: fields.subtasks.map(related),
	}
}

/** Where a person opens an issue on the site. */
export function issueUrl(siteUrl: string, key: string): string {
	return `${siteUrl}/browse/${key}`
}

function related(issue: NestedIssue): RelatedIssue {
	return { key: issue.key, summary: issue.fields.summary, status: issue.fields.status?.name ?? '' }
}
