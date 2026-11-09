import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AppPlatform } from '@mesh-flow/protocol'
import type { NativePackage } from './native-packages.mts'

/**
 * Installs `packages` into the built app in `out` for `platform`, with npm, so npm picks the
 * prebuilt binaries the sandbox needs whatever machine builds. A package that compiles its native
 * code can only be built on the sandbox's own platform.
 */
export async function installForPlatform(
	out: string,
	packages: readonly NativePackage[],
	platform: AppPlatform,
	abortSignal: AbortSignal,
): Promise<void> {
	const here = { os: process.platform, cpu: process.arch }
	const compiled = packages.filter((native) => native.buildsFromSource)
	if (compiled.length > 0 && (here.os !== platform.os || here.cpu !== platform.cpu)) {
		const names = compiled.map((native) => native.name).join(', ')
		throw new Error(
			`${names} compile native code when installed, so the app has to be built on ${platform.os}-${platform.cpu}, the sandbox's platform, not on ${here.os}-${here.cpu}.`,
		)
	}
	const dependencies = Object.fromEntries(packages.map((native) => [native.name, native.version]))
	await writeFile(path.join(out, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }, null, '\t'))
	if (packages.length === 0) return
	const args = ['install', '--omit=dev', '--no-audit', '--no-fund', `--os=${platform.os}`, `--cpu=${platform.cpu}`]
	await run('npm', args, out, { npm_config_platform: platform.os, npm_config_arch: platform.cpu }, abortSignal)
}

function run(command: string, args: readonly string[], cwd: string, env: Record<string, string>, abortSignal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		// npm is a `.cmd` on Windows, which only starts through a shell.
		const child = spawn(command, args, {
			cwd,
			env: { ...process.env, ...env },
			shell: process.platform === 'win32',
			stdio: 'inherit',
			signal: abortSignal,
		})
		child.on('error', reject)
		child.on('close', (code) => {
			if (code === 0) resolve()
			else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${String(code)}.`))
		})
	})
}
