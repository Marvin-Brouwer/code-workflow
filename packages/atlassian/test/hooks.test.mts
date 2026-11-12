import { workflow } from '@mesh-flow/core'
import { describe, expect, test } from 'vitest'
import { JiraIssueParameters } from '../src/_module/atlassian.mts'
import { jira } from '../src/_module/hooks.mts'

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
