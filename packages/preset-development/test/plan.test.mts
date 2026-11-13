import { describe, expect, test } from 'vitest'
import { deliveryOrder, Plan } from '../src/_module/preset-development.mts'

const plan = {
	path: '/workspace/plan.md',
	repositories: [
		{ repository: 'team/contracts', changes: 'Add the refund event' },
		{ repository: 'team/api', changes: 'Publish refunds' },
		{ repository: 'team/docs', changes: 'Describe refunds' },
	],
	dependencies: [
		{ repository: 'team/api', dependsOn: 'team/contracts', reason: 'the new event type' },
		{ repository: 'team/api', dependsOn: 'team/contracts', reason: 'its serializer' },
	],
}

describe('Plan', () => {
	test('takes a plan whose dependencies name its repositories', () => {
		// Act
		const parsed = Plan.safeParse(plan)

		// Assert
		expect(parsed.success).toBe(true)
	})

	test('refuses a dependency on a repository the plan does not list, and a relative path', () => {
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

	test('refuses a repository listed twice in another case, as code hosts ignore case in names', () => {
		// Arrange
		const twice = { ...plan, repositories: [...plan.repositories, { repository: 'Team/API', changes: 'Publish refunds again' }] }

		// Act
		const parsed = Plan.safeParse(twice)

		// Assert
		expect(parsed.error?.issues.map((issue) => issue.message)).toEqual(['List every repository once.'])
	})

	test('refuses a repository that depends on itself, directly or through another', () => {
		// Arrange
		const apiInCycle = "team/api ends up depending on itself: a repository can only wait for others that don't wait for it."
		const onItself = { ...plan, dependencies: [{ repository: 'team/api', dependsOn: 'team/api', reason: 'itself' }] }
		const roundabout = {
			...plan,
			dependencies: [
				{ repository: 'team/api', dependsOn: 'team/contracts', reason: 'the new event type' },
				{ repository: 'team/contracts', dependsOn: 'team/docs', reason: 'the wording' },
				{ repository: 'team/docs', dependsOn: 'team/api', reason: 'the endpoints' },
			],
		}

		// Act
		const parsed = [Plan.safeParse(onItself), Plan.safeParse(roundabout)]

		// Assert
		expect(parsed.map((result) => result.error?.issues.map((issue) => issue.message))).toEqual([[apiInCycle], [apiInCycle]])
	})
})

describe('deliveryOrder', () => {
	test('gives a node per repository, depending on what the plan says it needs first', () => {
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

	test('matches a dependency to the repository it names in another case', () => {
		// Arrange
		const parsed = Plan.parse({
			...plan,
			dependencies: [{ repository: 'Team/API', dependsOn: 'TEAM/contracts', reason: 'the new event type' }],
		})

		// Act
		const order = deliveryOrder(parsed)

		// Assert
		expect(order.map(({ id, dependsOn, hasDependents }) => ({ id, dependsOn, hasDependents }))).toEqual([
			{ id: 'team/contracts', dependsOn: [], hasDependents: true },
			{ id: 'team/api', dependsOn: ['team/contracts'], hasDependents: false },
			{ id: 'team/docs', dependsOn: [], hasDependents: false },
		])
	})
})
