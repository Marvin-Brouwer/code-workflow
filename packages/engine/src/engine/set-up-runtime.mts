import type { RunStart } from '@mesh-flow/protocol'
import type { Command, ExecResult, Sandbox } from '@mesh-flow/sandbox'
import { tailLines, type SandboxChannel } from '../mailbox/sandbox-channel.mts'
import { uploadWorkflowSource } from '../workflow/upload-workflow-source.mts'
import type { WorkflowConfig } from '../workflow/workflow-config.mts'
import type { SandboxLayout } from './sandbox-layout.mts'

/** What a sandbox needs to run the entry file. */
export interface RuntimeSetup {
	/** The packed workflow source on the host. */
	readonly tarball: string
	readonly config: WorkflowConfig
	/** The entry file, relative to the repository. */
	readonly file: string
	readonly layout: SandboxLayout
	/** What the entry file is to do. */
	readonly start: RunStart
	/** Extra environment for the runtime, such as the run id. */
	readonly env: Readonly<Record<string, string>>
}

/**
 * Prepares the mailbox, uploads the workflow source, runs the setup steps, writes the start file
 * and starts the runtime in the background. The same for a run and for describing an entry file.
 */
export async function setUpRuntime(
	sandbox: Sandbox,
	channel: SandboxChannel,
	setup: RuntimeSetup,
	abortSignal: AbortSignal,
): Promise<void> {
	const { config, layout } = setup
	await channel.prepare(abortSignal)
	await uploadWorkflowSource(sandbox, setup.tarball, layout.workflow, abortSignal)
	for (const command of config.setup) {
		const result = await sandbox.exec(command, { signal: abortSignal, cwd: layout.workflow })
		if (result.exitCode !== 0) throw setupFailure(command, result)
	}
	await channel.writeStart(setup.start, abortSignal)
	await channel.startRuntime([...config.start, setup.file], { signal: abortSignal, cwd: layout.workflow, env: setup.env })
}

/** A setup step that failed, with the end of what it wrote. */
function setupFailure(command: Command, result: ExecResult): Error {
	const output = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-tailLines).join('\n')
	return new Error(`Setup step '${command.join(' ')}' failed with exit code ${String(result.exitCode)}:\n${output}`)
}
