import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { SandboxSpec } from '@mesh-flow/sandbox'
import { z } from 'zod'

const Command = z.tuple([z.string().min(1)], z.string())

/** The file in a workflow repository that tells the engine how to run its workflows. */
export const workflowConfigFile = 'mesh-flow.config.json'

/**
 * How to run a repository's workflows, from `mesh-flow.config.json`. Non-secret team settings
 * only, because it lives in git.
 *
 * @example
 * ```json
 * {
 * 	"sandbox": { "image": "node:22-slim", "cpus": 2, "memoryMb": 4096, "egress": { "allow": ["registry.npmjs.org"] } },
 * 	"setup": [["npm", "ci"]],
 * 	"start": ["npx", "mesh-flow-runtime"]
 * }
 * ```
 */
export const WorkflowConfig = z.object({
	/** The sandbox every run of these workflows gets. */
	sandbox: SandboxSpec,
	/** Commands that run one after another in the uploaded repository before the workflow starts. */
	setup: z.array(Command).default([]),
	/** Starts the workflow runtime. The engine adds the workflow's file, relative to the repository. */
	start: Command,
	/** Where the workflows are, relative to the repository: `<workflows>/<name>.mts`. */
	workflows: z.string().min(1).default('workflows'),
})
export type WorkflowConfig = z.infer<typeof WorkflowConfig>

export async function loadWorkflowConfig(directory: string): Promise<WorkflowConfig> {
	const file = path.join(directory, workflowConfigFile)
	let text: string
	try {
		text = await readFile(file, 'utf8')
	} catch (error) {
		throw new Error(`No ${workflowConfigFile} in ${directory}.`, { cause: error })
	}
	const parsed = WorkflowConfig.safeParse(JSON.parse(text))
	if (!parsed.success) throw new Error(`${file} isn't valid:\n${z.prettifyError(parsed.error)}`)
	return parsed.data
}

/** The workflow's file relative to the repository, with POSIX separators for the sandbox. */
export function workflowFile(config: WorkflowConfig, workflow: string): string {
	if (!/^[\w-]+(?:\/[\w-]+)*$/.test(workflow)) throw new Error(`'${workflow}' isn't a workflow name.`)
	return path.posix.join(config.workflows.replaceAll('\\', '/'), `${workflow}.mts`)
}

/** A repository's config and the file of one of its workflows. Throws when either is missing. */
export async function findWorkflow(directory: string, workflow: string): Promise<{ config: WorkflowConfig; file: string }> {
	const config = await loadWorkflowConfig(directory)
	const file = workflowFile(config, workflow)
	if (!existsSync(path.join(directory, file))) throw new Error(`There is no workflow '${workflow}': ${file} doesn't exist in ${directory}.`)
	return { config, file }
}
