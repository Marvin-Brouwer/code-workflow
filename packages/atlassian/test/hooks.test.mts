import { workflow } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { JiraIssueParameters } from '../src/_module/atlassian.mts'
import { jira } from '../src/_module/hooks.mts'
import { markdownToWiki } from '../src/host/jira/markdown-to-wiki.mts'
import { signed } from '../src/host/signature.mts'

const updated = (fromString: string | null, toString: string | null) => ({
	webhookEvent: 'jira:issue_updated',
	issue: { key: 'PROJ-7', fields: { summary: 'Login fails', labels: ['ai-develop'] } },
	user: { displayName: 'Rita Reporter' },
	changelog: { items: [{ field: 'labels', fromString, toString }] },
})

describe('onIssueLabeled', () => {
	const develop = workflow('develop', JiraIssueParameters, async () => undefined)

	test('starts the workflow with the key when the label is put on', () => {
		// Arrange
		const trigger = jira.onIssueLabeled(develop, 'ai-develop')

		// Act
		const parameters = trigger.schema.safeParse(updated('web', 'web ai-develop'))

		// Assert
		expect(trigger).toMatchObject({ kind: 'webhook', id: 'develop-labeled-ai-develop', deliveryHeader: 'x-atlassian-webhook-identifier' })
		expect(parameters).toEqual({ success: true, data: { key: 'PROJ-7' } })
	})

	test('turns down an update that leaves the label as it was', () => {
		// Arrange
		const trigger = jira.onIssueLabeled(develop, 'ai-develop')

		// Act
		const parameters = trigger.schema.safeParse(updated('ai-develop', 'ai-develop web'))

		// Assert
		expect(parameters.success).toBe(false)
	})
})

describe('issueUpdated', () => {
	test('takes an update without a changelog, as Jira sends for a new comment', () => {
		// Arrange
		const { changelog: _changelog, ...withoutChangelog } = updated(null, null)

		// Act
		const parsed = jira.issueUpdated.safeParse(withoutChangelog)

		// Assert
		expect(parsed.data?.changelog).toEqual({ items: [] })
	})
})

/** A delivery of the `comment_created` event for a comment with `body`. */
function commented(body: string | undefined) {
	return {
		webhookEvent: 'comment_created',
		issue: { key: 'PROJ-7', fields: { summary: 'Login fails', labels: [] } },
		comment: { id: '10', author: { displayName: 'Rita Reporter' }, ...(body === undefined ? {} : { body }) },
	}
}

describe('commentCreated', () => {
	test("leaves out the connector's own comments, as Cloud and Data Center write them, also as JSON Schema", () => {
		// Arrange
		const personComment = 'Can you check Safari too?\n\nAnd Firefox.'
		const answer = signed('Checked both.', 'run-1')
		const escaped = markdownToWiki(answer).replace('@mesh-flow/*', '@mesh-flow/\\*')
		const bodies = [personComment, undefined, answer, markdownToWiki(answer), escaped]
		const bodyPattern = z.object({
			properties: z.object({ comment: z.object({ properties: z.object({ body: z.object({ pattern: z.string() }) }) }) }),
		})
		const { pattern } = bodyPattern.parse(z.toJSONSchema(jira.commentCreated, { io: 'input' })).properties.comment.properties.body

		// Act
		const fits = bodies.map((body) => jira.commentCreated.safeParse(commented(body)).success)
		const fitsStructure = [personComment, answer, markdownToWiki(answer), escaped].map((body) => new RegExp(pattern, 'u').test(body))

		// Assert
		expect(escaped).toContain('@mesh-flow/\\*')
		expect(fits).toEqual([true, true, false, false, false])
		expect(fitsStructure).toEqual([true, false, false, false])
	})
})
