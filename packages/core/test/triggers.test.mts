import { describe, expect, expectTypeOf, test } from 'vitest'
import { z } from 'zod'
import { defineWorkflows } from '../src/triggers/define-workflows.mts'
import { describeEntry } from '../src/triggers/describe-entry.mts'
import { schedule } from '../src/triggers/schedule.mts'
import { userTrigger } from '../src/triggers/user-trigger.mts'
import { webhook } from '../src/triggers/webhook.mts'
import { workflow, type NoParameters, type ParametersOf } from '../src/workflow/workflow.mts'

const fixIssue = workflow('fix-issue', { issue: z.number() }, async ({ parameters }) => {
	expectTypeOf(parameters).toEqualTypeOf<{ issue: number }>()
})
const report = workflow('report', async ({ parameters, abortSignal }) => {
	expectTypeOf(parameters).toEqualTypeOf<NoParameters>()
	expectTypeOf(abortSignal).toEqualTypeOf<AbortSignal>()
})
const IssueLabeled = z.object({ action: z.literal('labeled'), issue: z.object({ number: z.number() }) })
const toParameters = IssueLabeled.transform((event) => ({ issue: event.issue.number }))
const toStringIssue = IssueLabeled.transform((event) => ({ issue: String(event.issue.number) }))

describe('trigger types', () => {
	// These are checked by the compiler: an Act that compiles, and an Assert that a wrong call doesn't.
	test('a workflow takes the input side of its parameters', () => {
		// Assert
		expectTypeOf<ParametersOf<typeof fixIssue>>().toEqualTypeOf<{ issue: number }>()
	})

	test('a webhook schema has to give the workflow its parameters', () => {
		// Act
		webhook(fixIssue, toParameters)

		// Assert
		// @ts-expect-error The schema gives the whole event, not { issue }.
		webhook(fixIssue, IssueLabeled)
		// @ts-expect-error The issue is a string here, the workflow wants a number.
		webhook(fixIssue, toStringIssue)
	})

	test('a schedule gives the parameters the workflow needs, and none when it needs none', () => {
		// Act
		schedule(fixIssue, '0 7 * * 1', { issue: 1 })
		schedule(report, '0 7 * * 1')

		// Assert
		// @ts-expect-error fix-issue needs an issue.
		schedule(fixIssue, '0 7 * * 1')
		// @ts-expect-error The issue is a number.
		schedule(fixIssue, '0 7 * * 1', { issue: '1' })
	})
})

describe('defineWorkflows', () => {
	test('lists its triggers by kind and id', () => {
		// Act
		const entry = defineWorkflows(userTrigger(fixIssue), webhook(fixIssue, toParameters), schedule(report, '0 7 * * 1'))

		// Assert
		expect(entry.triggers.map((trigger) => [trigger.kind, trigger.id])).toEqual([
			['user', 'fix-issue'],
			['webhook', 'fix-issue'],
			['schedule', 'report 0 7 * * 1'],
		])
	})

	test('refuses a trigger twice, and says how to tell two webhooks apart', () => {
		// Arrange
		const triggers = [webhook(fixIssue, toParameters), webhook(fixIssue, toParameters)]

		// Act
		const defining = () => defineWorkflows(...triggers)

		// Assert
		expect(defining).toThrow('Give the second one a name of its own')
	})

	test('describes the workflows it is given, with their parameters as JSON Schema', () => {
		// Arrange
		const entry = defineWorkflows(userTrigger(fixIssue), schedule(report, '0 7 * * 1'))

		// Act
		const description = describeEntry(entry, [fixIssue, report])

		// Assert
		expect(description).toEqual({
			workflows: [
				{ name: 'fix-issue', parameters: { type: 'object', properties: { issue: { type: 'number' } }, required: ['issue'] } },
				{ name: 'report', parameters: { type: 'object', properties: {} } },
			],
			triggers: [
				{ kind: 'user', id: 'fix-issue', workflow: 'fix-issue' },
				{ kind: 'schedule', id: 'report 0 7 * * 1', workflow: 'report', cron: '0 7 * * 1', parameters: {} },
			],
		})
	})

	test('fills in the default signature and keeps header names in lowercase', () => {
		// Act
		const plain = webhook(report, z.object({}))
		const signed = webhook(report, z.object({}), {
			name: 'signed',
			signature: { scheme: 'hmac-sha256', header: 'X-Hub-Signature-256', prefix: 'sha256=' },
			deliveryHeader: 'X-GitHub-Delivery',
		})

		// Assert
		expect(plain.signature).toEqual({ scheme: 'secret-header', header: 'x-webhook-secret' })
		expect(signed).toMatchObject({
			signature: { scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' },
			deliveryHeader: 'x-github-delivery',
		})
	})
})
