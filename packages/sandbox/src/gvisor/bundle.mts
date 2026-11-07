import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface BundleOptions {
	readonly rootfs: string
	/** The container's init. It must keep running: when it exits, the container stops. */
	readonly init: readonly string[]
	readonly env: Readonly<Record<string, string>>
	readonly cpus: number
	readonly memoryMb: number
	/** Host directories bind-mounted into the sandbox, read-only. */
	readonly mounts: readonly { readonly source: string; readonly destination: string }[]
}

const defaultPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const capabilities = ['CAP_AUDIT_WRITE', 'CAP_KILL', 'CAP_NET_BIND_SERVICE']
const cpuPeriod = 100_000

/**
 * Writes an OCI bundle (`config.json`) around a shared root filesystem. A restore needs the same
 * bundle as the run it continues, so it stays until the sandbox is removed.
 *
 * Written here rather than with `runsc spec`, because with `sudo runsc` that file would belong to
 * root.
 */
export async function writeBundle(directory: string, options: BundleOptions): Promise<void> {
	const config = {
		ociVersion: '1.0.0',
		process: {
			user: { uid: 0, gid: 0 },
			args: options.init,
			env: [`PATH=${defaultPath}`, ...Object.entries(options.env).map(([key, value]) => `${key}=${value}`)],
			cwd: '/',
			capabilities: { bounding: capabilities, effective: capabilities, inheritable: capabilities, permitted: capabilities },
			rlimits: [{ type: 'RLIMIT_NOFILE', hard: 1024, soft: 1024 }],
		},
		// Read-write, but gVisor keeps every write in its in-memory overlay: the shared rootfs on
		// the host is never changed, and the writes are part of a checkpoint.
		root: { path: options.rootfs, readonly: false },
		hostname: 'sandbox',
		mounts: [
			{ destination: '/proc', type: 'proc', source: 'proc' },
			{ destination: '/dev', type: 'tmpfs', source: 'tmpfs' },
			{ destination: '/sys', type: 'sysfs', source: 'sysfs', options: ['nosuid', 'noexec', 'nodev', 'ro'] },
			...options.mounts.map((mount) => ({ ...mount, type: 'bind', options: ['rbind', 'ro'] })),
		],
		linux: {
			namespaces: ['pid', 'network', 'ipc', 'uts', 'mount'].map((type) => ({ type })),
			resources: {
				memory: { limit: options.memoryMb * 1024 * 1024 },
				cpu: { quota: options.cpus * cpuPeriod, period: cpuPeriod },
			},
		},
	}
	await rm(directory, { recursive: true, force: true })
	await mkdir(directory, { recursive: true })
	await writeFile(path.join(directory, 'config.json'), JSON.stringify(config, null, 2))
}
