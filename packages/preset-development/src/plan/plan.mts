import path from 'node:path'
import { workspace } from '@mesh-flow/core'
import { z } from 'zod'

/** Where the planner writes the plan. In a prompt it renders as its absolute path, which `Plan.path` takes. */
export const planFile = workspace.file('plan.md')

/** One repository the plan changes. */
const PlannedRepository = z.object({
	repository: z.string().min(1).describe('The repository as the code host names it, such as group/project'),
	changes: z.string().min(1).describe('What changes in this repository, in short'),
})

/**
 * One edge of the dependency graph: `repository` builds against packages that `dependsOn` publishes,
 * so `dependsOn` has to be merged, and its packages published, first.
 */
const PlannedDependency = z.object({
	repository: z.string().min(1).describe('The repository that needs it'),
	dependsOn: z.string().min(1).describe('The repository whose packages it needs, merged and published first'),
	reason: z.string().min(1).describe('Which of its packages it needs, and for what'),
})

/**
 * A repository's name as the plan compares it: in lower case, since code hosts ignore case in
 * names, and so do the checkout folders.
 */
export function repositoryKey(repository: string): string {
	return repository.toLowerCase()
}

/**
 * A development plan, as the planner proposes it with `propose(Plan)`: the plan itself is a
 * Markdown file, and this is what code needs from it. Every dependency names repositories the plan
 * lists, so the delivery order can be made from it.
 */
export const Plan = z
	.object({
		path: z
			.string()
			.refine((value) => path.isAbsolute(value), 'Give the absolute path, so agents find it from inside a checkout.')
			.describe('The absolute path of the plan, plan.md'),
		repositories: z.array(PlannedRepository).min(1),
		dependencies: z.array(PlannedDependency).describe('The dependency graph between the repositories; empty when they are independent'),
	})
	.superRefine((plan, context) => {
		const names = new Set(plan.repositories.map(({ repository }) => repositoryKey(repository)))
		if (names.size !== plan.repositories.length)
			context.addIssue({ code: 'custom', path: ['repositories'], message: 'List every repository once.' })
		for (const [index, dependency] of plan.dependencies.entries())
			for (const field of ['repository', 'dependsOn'] as const)
				if (!names.has(repositoryKey(dependency[field])))
					context.addIssue({
						code: 'custom',
						path: ['dependencies', index, field],
						message: `${dependency[field]} isn't one of the plan's repositories.`,
					})
		const cyclic = inCycle(plan.dependencies)
		// As the plan lists it, not in the lower case the names are compared in.
		const listed = plan.repositories.find(({ repository }) => repositoryKey(repository) === cyclic)?.repository ?? cyclic
		if (cyclic !== undefined)
			context.addIssue({
				code: 'custom',
				path: ['dependencies'],
				message: `${listed} ends up depending on itself: a repository can only wait for others that don't wait for it.`,
			})
	})
export type Plan = z.infer<typeof Plan>

/**
 * A repository that, through its dependencies, ends up depending on itself, when there is one:
 * such a plan has no order to deliver its repositories in.
 */
function inCycle(dependencies: readonly z.infer<typeof PlannedDependency>[]): string | undefined {
	const needs = Map.groupBy(dependencies, (dependency) => repositoryKey(dependency.repository))
	const done = new Set<string>()
	const visiting = new Set<string>()
	const visit = (key: string): string | undefined => {
		if (visiting.has(key)) return key
		if (done.has(key)) return undefined
		visiting.add(key)
		for (const { dependsOn } of needs.get(key) ?? []) {
			const found = visit(repositoryKey(dependsOn))
			if (found !== undefined) return found
		}
		visiting.delete(key)
		done.add(key)
		return undefined
	}
	for (const { repository } of dependencies) {
		const found = visit(repositoryKey(repository))
		if (found !== undefined) return found
	}
	return undefined
}
