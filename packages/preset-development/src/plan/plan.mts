import path from 'node:path'
import { workspace } from '@mesh-flow/core'
import { z } from 'zod'

/** Where the planner writes the plan. In a prompt it renders as its absolute path, which `Plan.path` takes. */
export const planFile = workspace.file('plan.md')

/** One repository the plan changes. */
const PlannedRepository = z.object({
	name: z.string().min(1).describe('The repository as the source host names it, such as group/project'),
	changes: z.string().min(1).describe('What changes in this repository, in short'),
})

/** One edge of the dependency graph: `repository` needs `dependsOn` merged and published first. */
const PlannedDependency = z.object({
	repository: z.string().min(1),
	dependsOn: z.string().min(1).describe('The repository that has to be merged and published first'),
	reason: z.string().min(1).describe('What it needs from it, such as a new package version or an API contract'),
})

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
		const names = new Set(plan.repositories.map((repository) => repository.name))
		if (names.size !== plan.repositories.length)
			context.addIssue({ code: 'custom', path: ['repositories'], message: 'List every repository once.' })
		for (const [index, dependency] of plan.dependencies.entries())
			for (const field of ['repository', 'dependsOn'] as const)
				if (!names.has(dependency[field]))
					context.addIssue({
						code: 'custom',
						path: ['dependencies', index, field],
						message: `${dependency[field]} isn't one of the plan's repositories.`,
					})
	})
export type Plan = z.infer<typeof Plan>
