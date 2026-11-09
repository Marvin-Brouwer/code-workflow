import type { WorkflowsDescription } from '@mesh-flow/protocol'
import type { SandboxBackend } from '@mesh-flow/sandbox'
import type { SandboxLayout } from '../engine/sandbox-layout.mts'
import { setUpRuntime } from '../engine/set-up-runtime.mts'
import { messageOf } from '../errors.mts'
import { SandboxChannel } from '../mailbox/sandbox-channel.mts'
import type { WorkflowConfig } from '../workflow/workflow-config.mts'

/** What describing an entry file needs. */
export interface DescribeInSandboxOptions {
	readonly backend: SandboxBackend
	readonly layout: SandboxLayout
	readonly config: WorkflowConfig
	/** The entry file, relative to the repository. */
	readonly file: string
	/** The packed workflow source. */
	readonly tarball: string
	/** Bounds removing the sandbox afterwards, whatever happened. */
	readonly cleanupSignal: () => AbortSignal
	readonly log: (message: string) => void
}

/**
 * Runs the entry file in describe mode in a sandbox of its own and returns what it declares. The
 * entry file is workflow code, so it never runs on the host. The sandbox is removed afterwards.
 */
export async function describeInSandbox(options: DescribeInSandboxOptions, abortSignal: AbortSignal): Promise<WorkflowsDescription> {
	const { backend, layout } = options
	const sandbox = await backend.create(options.config.sandbox, abortSignal)
	try {
		const channel = new SandboxChannel(sandbox, layout.mailbox)
		const setup = { ...options, start: { mode: 'describe' }, env: {} } as const
		await setUpRuntime(sandbox, channel, setup, abortSignal)
		for (let cursor = 0; ;) {
			const delivery = await channel.poll(cursor, abortSignal)
			if (delivery.kind === 'gone') {
				const log = await channel.logTail(abortSignal).catch(() => '')
				throw new Error(`The entry file exited without describing itself.${log ? `\n${log}` : ''}`)
			}
			for (const message of delivery.messages) {
				if (message.type === 'described') return message.description
				if (message.type === 'failed') throw new Error(`Describing the entry file failed: ${message.error}`)
			}
			cursor = delivery.cursor
		}
	} finally {
		await backend.remove(sandbox.id, options.cleanupSignal()).catch((error: unknown) => {
			options.log(`Removing sandbox ${sandbox.id} after describing failed: ${messageOf(error)}`)
		})
	}
}
