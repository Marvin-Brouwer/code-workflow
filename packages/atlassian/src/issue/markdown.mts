import { withFrontmatter } from '../frontmatter.mts'
import type { IssueComment, IssueData, RelatedIssue } from '../tools/issue-tools.mts'

/**
 * The issue as Markdown: its facts and relations as frontmatter, then a heading with its key and
 * summary, its description and its comments.
 */
export function issueMarkdownOf(data: IssueData): string {
	const description = data.description.trim()
	const metadata = {
		key: data.key,
		summary: data.summary,
		url: data.url,
		type: data.type,
		status: data.status,
		priority: data.priority,
		assignee: data.assignee,
		reporter: data.reporter,
		labels: data.labels,
		components: data.components,
		parent: data.parent === null ? null : related(data.parent),
		created: data.created,
		updated: data.updated,
		links: data.links.map((link) => ({ relation: link.relation, ...related(link) })),
		subtasks: data.subtasks.map(related),
	}
	const body = [
		`# ${data.key}: ${data.summary}`,
		'',
		'## Description',
		'',
		description === '' ? '(no description)' : description,
		'',
		...section('Comments', data.comments.flatMap(commentLines)),
	].join('\n')
	return withFrontmatter(metadata, body)
}

function related(issue: RelatedIssue): RelatedIssue {
	return { key: issue.key, summary: issue.summary, status: issue.status }
}

/** A heading and its lines under a blank line, or nothing when there are no lines. */
function section(heading: string, lines: readonly string[]): string[] {
	return lines.length === 0 ? [] : [`## ${heading}`, '', ...lines, '']
}

function commentLines(comment: IssueComment): string[] {
	return [`### ${comment.author}, ${comment.created}`, '', comment.body.trim(), '']
}
