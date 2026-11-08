import { defaultMailboxDirectory } from '@mesh-flow/protocol'

/** Where the engine puts things inside a sandbox. POSIX paths. */
export interface SandboxLayout {
	/** The mailbox between the engine and the runtime. */
	readonly mailbox: string
	/** The uploaded workflow repository, where setup and the runtime run. */
	readonly workflow: string
}

export const defaultSandboxLayout: SandboxLayout = {
	mailbox: defaultMailboxDirectory,
	workflow: '/workflow',
}
