import type { DependencyNode } from '@mesh-flow/core'
import { repositoryKey, type Plan } from './plan.mts'

/** One repository of a plan, as `inDependencyOrder` delivers it. */
export interface Delivery extends DependencyNode {
	/** The repository as the code host names it; the node's id too. */
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
 * 	const repository = await gitlab.checkout({ repository: part.repository, branch: `feature/${story.key}` })
 * 	// ...
 * })
 * ```
 */
export function deliveryOrder(plan: Plan): readonly Delivery[] {
	// A dependency may spell a name in another case than the plan lists it: the ids are as listed.
	const listed = new Map(plan.repositories.map(({ repository }) => [repositoryKey(repository), repository]))
	const edges = plan.dependencies.map((dependency) => ({
		needs: repositoryKey(dependency.repository),
		dependsOn: listed.get(repositoryKey(dependency.dependsOn)) ?? dependency.dependsOn,
	}))
	return plan.repositories.map(({ repository, changes }) => ({
		id: repository,
		repository,
		changes,
		dependsOn: [...new Set(edges.filter(({ needs }) => needs === repositoryKey(repository)).map(({ dependsOn }) => dependsOn))],
		hasDependents: edges.some(({ dependsOn }) => dependsOn === repository),
	}))
}
