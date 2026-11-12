import type { IssueComment, IssueData, RelatedIssue } from '../tools/issue-tools.mts'

/** The issue as Markdown: a heading with its key and summary, its facts, its description, then its relations and comments. */
export function markdownOf(data: IssueData): string {
	const description = data.description.trim()
	return [
		`# ${data.key}: ${data.summary}`,
		'',
		`- URL: ${data.url}`,
		`- Type: ${data.type}`,
		`- Status: ${data.status}`,
		`- Priority: ${data.priority ?? 'none'}`,
		`- Assignee: ${data.assignee ?? 'unassigned'}`,
		`- Reporter: ${data.reporter ?? 'unknown'}`,
		`- Labels: ${listed(data.labels)}`,
		`- Components: ${listed(data.components)}`,
		...(data.parent === null ? [] : [`- Parent: ${related(data.parent)}`]),
		`- Created: ${data.created}`,
		`- Updated: ${data.updated}`,
		'',
		'## Description',
		'',
		description === '' ? '(no description)' : description,
		'',
		...section(
			'Linked issues',
			data.links.map((link) => `- ${link.relation} ${related(link)}`),
		),
		...section(
			'Subtasks',
			data.subtasks.map((subtask) => `- ${related(subtask)}`),
		),
		...section('Comments', data.comments.flatMap(commentLines)),
	].join('\n')
}

function listed(values: readonly string[]): string {
	return values.length === 0 ? 'none' : values.join(', ')
}

function related(issue: RelatedIssue): string {
	return `${issue.key}: ${issue.summary} (${issue.status})`
}

/** A heading and its lines under a blank line, or nothing when there are no lines. */
function section(heading: string, lines: readonly string[]): string[] {
	return lines.length === 0 ? [] : [`## ${heading}`, '', ...lines, '']
}

function commentLines(comment: IssueComment): string[] {
	return [`### ${comment.author}, ${comment.created}`, '', comment.body.trim(), '']
}
