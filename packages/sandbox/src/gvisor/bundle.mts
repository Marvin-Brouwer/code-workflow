import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Rootfs } from './rootfs.mts'

export interface BundleOptions {
	readonly rootfs: Rootfs
	/** The container's init. It must keep running: when it exits, the container stops. */
	readonly init: readonly string[]
	/** On top of the image's environment. */
	readonly env: Readonly<Record<string, string>>
	readonly cpus: number
	readonly memoryMb: number
	/** Host directories bind-mounted into the sandbox, read-only. */
	readonly mounts: readonly { readonly source: string; readonly destination: string }[]
}

const defaultPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const cpuPeriod = 100_000

/**
 * Docker's default set, so root in the sandbox can do what it can in a container: install
 * packages, change owners, drop to another user. gVisor keeps all of it inside the sandbox.
 */
const capabilities = [
	'CAP_AUDIT_WRITE',
	'CAP_CHOWN',
	'CAP_DAC_OVERRIDE',
	'CAP_FOWNER',
	'CAP_FSETID',
	'CAP_KILL',
	'CAP_MKNOD',
	'CAP_NET_BIND_SERVICE',
	'CAP_NET_RAW',
	'CAP_SETFCAP',
	'CAP_SETGID',
	'CAP_SETPCAP',
	'CAP_SETUID',
	'CAP_SYS_CHROOT',
]

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
			env: environment(options.rootfs.env, options.env),
			cwd: options.rootfs.workingDir,
			capabilities: { bounding: capabilities, effective: capabilities, inheritable: capabilities, permitted: capabilities },
			rlimits: [{ type: 'RLIMIT_NOFILE', hard: 1024, soft: 1024 }],
		},
		// Read-write, but gVisor keeps every write in its in-memory overlay: the shared rootfs on
		// the host is never changed, and the writes are part of a checkpoint.
		root: { path: options.rootfs.path, readonly: false },
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

/** The image's `KEY=value` entries with `env` on top, each key once, and a `PATH` either way. */
function environment(image: readonly string[], env: Readonly<Record<string, string>>): string[] {
	const merged = new Map<string, string>([['PATH', defaultPath]])
	for (const entry of image) {
		const separator = entry.indexOf('=')
		if (separator > 0) merged.set(entry.slice(0, separator), entry.slice(separator + 1))
	}
	for (const [key, value] of Object.entries(env)) merged.set(key, value)
	return [...merged].map(([key, value]) => `${key}=${value}`)
}
