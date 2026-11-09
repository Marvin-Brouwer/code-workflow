import type { RunStart } from '@mesh-flow/protocol'
import type { Sandbox } from '@mesh-flow/sandbox'
import { uploadApp } from '../apps/upload-app.mts'
import type { SandboxChannel } from '../mailbox/sandbox-channel.mts'
import type { SandboxLayout } from './sandbox-layout.mts'

/** What a sandbox needs to run a built app. */
export interface RuntimeSetup {
	/** The built app, packed, on the host. */
	readonly tarball: string
	/** The built entry file, relative to the app. */
	readonly entry: string
	readonly layout: SandboxLayout
	/** What the app is to do. */
	readonly start: RunStart
	/** Extra environment for the runtime, such as the run id. */
	readonly env: Readonly<Record<string, string>>
}

/**
 * Prepares the mailbox, uploads the built app, writes the start file and starts `node <entry>` in
 * the background. The app was built with its dependencies, so there is nothing to set up.
 */
export async function setUpRuntime(
	sandbox: Sandbox,
	channel: SandboxChannel,
	setup: RuntimeSetup,
	abortSignal: AbortSignal,
): Promise<void> {
	const { layout } = setup
	await channel.prepare(abortSignal)
	await uploadApp(sandbox, setup.tarball, layout.workflow, abortSignal)
	await channel.writeStart(setup.start, abortSignal)
	await channel.startRuntime(['node', setup.entry], { signal: abortSignal, cwd: layout.workflow, env: setup.env })
}
