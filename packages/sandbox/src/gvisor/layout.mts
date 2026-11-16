import path from 'node:path'

/** Where everything for one sandbox lives on the host. */
export interface SandboxPaths {
	readonly directory: string
	readonly bundle: string
	/** One directory per pause, named after it; a pause in progress ends in `.partial`. */
	readonly checkpoints: string
	/** stdout and stderr of the container's init. */
	readonly log: string
}

/**
 * The gVisor backend's directory:
 *
 * ```text
 * runsc/                runsc's own state (--root)
 * images/<image>/       unpacked root filesystems, shared by every sandbox of that image
 * sandboxes/<id>/       bundle/, checkpoints/, init.log
 * ```
 */
export class Layout {
	readonly directory: string

	constructor(directory: string) {
		this.directory = directory
	}

	get runscRoot(): string {
		return path.join(this.directory, 'runsc')
	}

	get images(): string {
		return path.join(this.directory, 'images')
	}

	get sandboxes(): string {
		return path.join(this.directory, 'sandboxes')
	}

	sandbox(id: string): SandboxPaths {
		const directory = path.join(this.sandboxes, id)
		return {
			directory,
			bundle: path.join(directory, 'bundle'),
			checkpoints: path.join(directory, 'checkpoints'),
			log: path.join(directory, 'init.log'),
		}
	}
}
