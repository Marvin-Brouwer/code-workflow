// TEMPORARY: reproduces a rare CI failure of the package proxy tests; removed once it named its cause.
import { execFile } from 'node:child_process'
import { expect, test } from 'vitest'
import { GatewayCallError } from '../src/gateway/gateway-client.mts'
import { startPackageAccess } from '../src/packages/package-access.mts'
import { npmRegistry, nugetOrg } from './support/registries.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const tries = 400

test.runIf(process.platform === 'linux')('answers every curl through the proxy', { timeout: 600_000 }, async () => {
	const failures: string[] = []
	for (let attempt = 0; attempt < tries; attempt++) {
		const stop = new AbortController()
		const directory = await temporaryDirectory()
		const transient = attempt % 2 === 0
		const { proxy, environment } = await startPackageAccess({
			registries: [npmRegistry, nugetOrg],
			fetchStaged: () => Promise.reject(new GatewayCallError('npm is down.', { transient })),
			directory,
			abortSignal: stop.signal,
		})
		const answered = await new Promise<string>((resolve) => {
			execFile(
				'curl',
				[
					'--silent',
					'--show-error',
					'--verbose',
					'--output',
					'/dev/null',
					'--write-out',
					'%{http_code}',
					'https://registry.npmjs.org/left-pad',
				],
				{ env: { PATH: process.env.PATH, HOME: directory, ...environment } },
				(error, stdout, stderr) => {
					resolve(
						stdout.trim() === (transient ? '502' : '403') ? '' : `${String(attempt)}: ${stdout} exit ${String(error?.code)}\n${stderr}`,
					)
				},
			)
		})
		await proxy.close()
		if (answered !== '') failures.push(answered)
	}
	expect(failures).toEqual([])
})
