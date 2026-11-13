import type { IssueAttachment, IssueData, IssueLink, RelatedIssue } from '../../tools/issue-tools.mts'
import { htmlToMarkdown, type RichTextOptions } from '../html-to-markdown.mts'
import type { Person } from '../mention.mts'
import { attachmentIdOf } from './attachments.mts'
import type { NestedIssue, RawIssue } from './raw-issue.mts'

/** What an issue's data takes besides Jira's answer: what the host read of its attachments and mentions. */
export interface IssueDataOptions {
	/** The issue's attachments, as `issueAttachments` brought them. */
	readonly attachments: readonly IssueAttachment[]
	/** The people its rich text mentions, as `peopleIn` found them. */
	readonly people: ReadonlyMap<string, Person>
}

/**
 * An issue as the sandbox gets it, from what Jira answered: its rich text as Markdown, with each
 * image of an attachment pointing at the attachment's copy next to the Markdown when there is one,
 * and at the site otherwise.
 */
export function issueData(raw: RawIssue, siteUrl: string, { attachments, people }: IssueDataOptions): IssueData {
	const { fields, renderedFields } = raw
	const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]))
	const richText: RichTextOptions = {
		imageSource: (src) => {
			const attachment = byId.get(attachmentIdOf(src) ?? '')
			return attachment?.file ?? attachment?.url ?? URL.parse(src, siteUrl)?.href ?? src
		},
		people,
	}
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
		description: htmlToMarkdown(renderedFields.description, richText),
		comments: (fields.comment?.comments ?? []).map((comment) => ({
			id: comment.id,
			author: comment.author?.displayName ?? 'unknown',
			created: comment.created,
			body: htmlToMarkdown(renderedComments.get(comment.id), richText),
		})),
		links: fields.issuelinks.flatMap((link): IssueLink[] => {
			if (link.outwardIssue !== undefined) return [{ ...related(link.outwardIssue), relation: link.type.outward }]
			if (link.inwardIssue !== undefined) return [{ ...related(link.inwardIssue), relation: link.type.inward }]
			return []
		}),
		subtasks: fields.subtasks.map(related),
		attachments: [...attachments],
	}
}

/** Where a person opens an issue on the site. */
export function issueUrl(siteUrl: string, key: string): string {
	return `${siteUrl}/browse/${key}`
}

function related(issue: NestedIssue): RelatedIssue {
	return { key: issue.key, summary: issue.fields.summary, status: issue.fields.status?.name ?? '' }
}
