import { defaultMailboxDirectory } from '@mesh-flow/protocol'

/** Where the engine puts things inside a sandbox. POSIX paths. */
export interface SandboxLayout {
	/** The mailbox between the engine and the runtime. */
	readonly mailbox: string
	/** The unpacked built app, where the runtime runs. */
	readonly app: string
}

/** The mailbox at the protocol's default place, and the app at `/mesh-flow/app`, clear of an image's own `/app`. */
export const defaultSandboxLayout: SandboxLayout = {
	mailbox: defaultMailboxDirectory,
	app: '/mesh-flow/app',
}
