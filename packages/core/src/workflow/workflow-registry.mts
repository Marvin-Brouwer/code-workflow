import type { AnyWorkflow } from './workflow.mts'

/**
 * Every workflow defined in this process, in the order they were defined. The entry file imports
 * the modules that define them, so a run can start any of them by name, also one no trigger lists.
 */
const defined: AnyWorkflow[] = []

/** Called by `workflow()` for every definition. */
export function registerWorkflow(definition: AnyWorkflow): void {
	defined.push(definition)
}

/** Every workflow defined so far, each name once. Throws when two different workflows share a name. */
export function definedWorkflows(): readonly AnyWorkflow[] {
	const byName = new Map<string, AnyWorkflow>()
	for (const definition of defined) {
		const known = byName.get(definition.name)
		if (known !== undefined && known !== definition) throw new Error(`Two workflows are called ${definition.name}. Give each its own name.`)
		byName.set(definition.name, definition)
	}
	return [...byName.values()]
}
