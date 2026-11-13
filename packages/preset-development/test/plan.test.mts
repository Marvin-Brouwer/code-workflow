import { describe, expect, it } from 'vitest'
import { deliveryOrder, Plan } from '../src/_module/preset-development.mts'

const plan = {
	path: '/workspace/plan.md',
	repositories: [
		{ name: 'team/contracts', changes: 'Add the refund event' },
		{ name: 'team/api', changes: 'Publish refunds' },
		{ name: 'team/docs', changes: 'Describe refunds' },
	],
	dependencies: [
		{ repository: 'team/api', dependsOn: 'team/contracts', reason: 'the new event type' },
		{ repository: 'team/api', dependsOn: 'team/contracts', reason: 'its serializer' },
	],
}

describe('Plan', () => {
	it('takes a plan whose dependencies name its repositories', () => {
		// Act
		const parsed = Plan.safeParse(plan)

		// Assert
		expect(parsed.success).toBe(true)
	})

	it('refuses a dependency on a repository the plan does not list, and a relative path', () => {
		// Arrange
		const wrong = {
			...plan,
			path: 'plan.md',
			dependencies: [{ repository: 'team/api', dependsOn: 'team/billing', reason: 'the invoice API' }],
		}

		// Act
		const parsed = Plan.safeParse(wrong)

		// Assert
		expect(parsed.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['path', 'dependencies.0.dependsOn'])
	})
})

describe('deliveryOrder', () => {
	it('gives a node per repository, depending on what the plan says it needs first', () => {
		// Arrange
		const parsed = Plan.parse(plan)

		// Act
		const order = deliveryOrder(parsed)

		// Assert
		expect(order).toEqual([
			{ id: 'team/contracts', repository: 'team/contracts', changes: 'Add the refund event', dependsOn: [], hasDependents: true },
			{ id: 'team/api', repository: 'team/api', changes: 'Publish refunds', dependsOn: ['team/contracts'], hasDependents: false },
			{ id: 'team/docs', repository: 'team/docs', changes: 'Describe refunds', dependsOn: [], hasDependents: false },
		])
	})
})
