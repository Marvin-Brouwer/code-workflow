import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { SandboxSpec } from '@mesh-flow/sandbox'
import { z } from 'zod'
import { messageOf } from '../errors.mts'

/** A command as its program and arguments, run without a shell. */
const CommandLine = z.tuple([z.string().min(1)], z.string())

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
	setup: z.array(CommandLine).default([]),
	/** Starts the workflow runtime. The engine adds the entry file, relative to the repository. */
	start: CommandLine,
	/** Where the workflows are, relative to the repository, with the entry file `<workflows>/main.mts`. */
	workflows: z.string().min(1).default('workflows'),
})
export type WorkflowConfig = z.infer<typeof WorkflowConfig>

/** Reads and checks the repository's `mesh-flow.config.json`. Throws when it's missing or invalid. */
export async function loadWorkflowConfig(directory: string): Promise<WorkflowConfig> {
	const file = path.join(directory, workflowConfigFile)
	let text: string
	try {
		text = await readFile(file, 'utf8')
	} catch (error) {
		throw new Error(`No ${workflowConfigFile} in ${directory}.`, { cause: error })
	}
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch (error) {
		throw new Error(`${file} isn't JSON: ${messageOf(error)}`, { cause: error })
	}
	const parsed = WorkflowConfig.safeParse(json)
	if (!parsed.success) throw new Error(`${file} isn't valid:\n${z.prettifyError(parsed.error)}`)
	return parsed.data
}

/** The entry file's name in the workflows folder. */
export const entryFileName = 'main.mts'

/** The entry file relative to the repository, with POSIX separators for the sandbox. */
export function entryFile(config: WorkflowConfig): string {
	return path.posix.join(config.workflows.replaceAll('\\', '/'), entryFileName)
}

/** A repository's config and its entry file. Throws when either is missing. */
export async function findEntry(directory: string): Promise<{ config: WorkflowConfig; file: string }> {
	const config = await loadWorkflowConfig(directory)
	const file = entryFile(config)
	if (!existsSync(path.join(directory, file))) {
		throw new Error(`There is no entry file in ${directory}: ${file} doesn't exist. It lists the workflows with defineWorkflows.`)
	}
	return { config, file }
}
