import type { DependencyNode } from '@mesh-flow/core'
import type { Plan } from './plan.mts'

/** One repository of a plan, as `inDependencyOrder` delivers it. */
export interface Delivery extends DependencyNode {
	/** The repository as the source host names it; the node's id too. */
	readonly repository: string
	/** What changes in it, as the plan says. */
	readonly changes: string
	/** Whether another repository of the plan waits for this one, and so for what its merge publishes. */
	readonly hasDependents: boolean
}

/**
 * The plan's repositories as nodes for `inDependencyOrder`, one each, in the plan's order: each
 * depends on the repositories the plan says it needs first.
 *
 * ```ts
 * await inDependencyOrder(deliveryOrder(plan), async (part, upstream) => {
 * 	const repository = await gitlab.checkout(part.repository, { branch })
 * 	// ...
 * })
 * ```
 */
export function deliveryOrder(plan: Plan): readonly Delivery[] {
	return plan.repositories.map((repository) => ({
		id: repository.name,
		repository: repository.name,
		changes: repository.changes,
		dependsOn: [
			...new Set(
				plan.dependencies.filter((dependency) => dependency.repository === repository.name).map((dependency) => dependency.dependsOn),
			),
		],
		hasDependents: plan.dependencies.some((dependency) => dependency.dependsOn === repository.name),
	}))
}
