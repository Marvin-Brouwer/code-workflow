import { describe, expect, test } from 'vitest'
import { DependencyOrderFailed, inDependencyOrder } from '../src/workflow/in-dependency-order.mts'
import { runBody } from './support/run-body.mts'

const node = (id: string, ...dependsOn: string[]) => ({ id, dependsOn })

describe('inDependencyOrder', () => {
	test('starts each node once its dependencies returned, and passes their results', async () => {
		// Arrange
		const started: string[] = []

		// Act
		const run = await runBody(() =>
			inDependencyOrder([node('web', 'api', 'lib'), node('api', 'lib'), node('lib')], async (part, upstream: readonly string[]) => {
				started.push(part.id)
				return [part.id, ...upstream].join('+')
			}),
		)

		// Assert
		expect(await run.result).toEqual({ lib: 'lib', api: 'api+lib', web: 'web+api+lib+lib' })
		expect(started).toEqual(['lib', 'api', 'web'])
	})

	test('runs independent nodes concurrently', async () => {
		// Arrange
		let running = 0
		let most = 0

		// Act
		const run = await runBody(() =>
			inDependencyOrder([node('a'), node('b'), node('c')], async () => {
				most = Math.max(most, ++running)
				await new Promise((resolve) => setTimeout(resolve, 20))
				running--
			}),
		)
		await run.result

		// Assert
		expect(most).toBe(3)
	})

	test('blocks only the dependents of a failed node and reports everything', async () => {
		// Act
		const run = await runBody(() =>
			inDependencyOrder([node('lib'), node('api', 'lib'), node('docs')], async (part) => {
				if (part.id === 'lib') throw new Error('build broke')
				return part.id
			}),
		)

		// Assert
		const error: unknown = await run.result.catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(DependencyOrderFailed)
		expect(error).toMatchObject({ results: { docs: 'docs' }, blocked: ['api'] })
	})

	test.each([
		['a cycle', [node('a', 'b'), node('b', 'a')], 'cycle: a → b → a'],
		['an unknown id', [node('a', 'x')], 'depends on x'],
		['a duplicate id', [node('a'), node('a')], 'twice'],
	])('refuses %s before anything runs', async (_name, nodes, message) => {
		// Arrange
		let ran = false

		// Act
		const run = await runBody(() =>
			inDependencyOrder(nodes, async () => {
				ran = true
			}),
		)

		// Assert
		await expect(run.result).rejects.toThrow(message)
		expect(ran).toBe(false)
	})
})
