import { createServer, type Server } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { HostToolContext } from '@mesh-flow/gateway'
import { describe, expect, onTestFinished, test } from 'vitest'
import { gitRemote } from '../src/host/git-remote.mts'
import { git, localRemote } from './support/local-remote.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const token = 'ghp_test'

/** A host tool context whose credential store has the token. */
function context(abortSignal = new AbortController().signal): HostToolContext {
	return { abortSignal, runId: 'run-1', credentials: { get: (name) => Promise.resolve(name === 'github/token' ? token : undefined) } }
}

/** How long a stopped call may take to settle while git hangs. */
const promptlyMs = 3_000

/** A clone of a bundle, in a fresh directory. */
async function cloneBundle(bundle: Buffer, branch: string): Promise<string> {
	const root = await temporaryDirectory()
	const file = path.join(root, 'clone.bundle')
	await writeFile(file, bundle)
	const checkout = path.join(root, 'checkout')
	await git(root, 'clone', '--quiet', '--branch', branch, file, checkout)
	return checkout
}

describe('gitRemote', () => {
	test('fetches a repository into a bundle with its default branch, saying the branch is new', async () => {
		// Arrange
		const remote = await localRemote()
		const host = gitRemote({ directory: await temporaryDirectory(), remoteUrl: () => remote.url })

		// Act
		const fetched = await host.fetchBundle('team/app', 'fix/1', context())

		// Assert
		expect(fetched).toMatchObject({ defaultBranch: 'main', branchExists: false })
		const checkout = await cloneBundle(fetched.bundle, 'main')
		expect(await readFile(path.join(checkout, 'README.md'), 'utf8')).toBe('# Example\n')
		expect(
			(await git(checkout, 'branch', '--remotes'))
				.trim()
				.split('\n')
				.map((line) => line.trim()),
		).toEqual(['origin/main'])
	})

	test('pushes the commits of a bundle the sandbox made to the branch, and sees the branch after that', async () => {
		// Arrange
		const remote = await localRemote()
		const host = gitRemote({ directory: await temporaryDirectory(), remoteUrl: () => remote.url })
		const fetched = await host.fetchBundle('team/app', 'fix/1', context())
		const checkout = await cloneBundle(fetched.bundle, 'main')
		await git(checkout, 'checkout', '--quiet', '-b', 'fix/1')
		await mkdir(path.join(checkout, 'src'), { recursive: true })
		await writeFile(path.join(checkout, 'src', 'fix.txt'), 'fixed\n')
		await git(checkout, 'add', '--all')
		await git(checkout, 'commit', '--quiet', '--message', 'Fix it')
		const bundleFile = path.join(checkout, '..', 'push.bundle')
		await git(checkout, 'bundle', 'create', '--quiet', bundleFile, 'origin/main..fix/1')

		// Act
		const head = await host.pushBundle('team/app', 'fix/1', await readFile(bundleFile), context())
		const again = await host.fetchBundle('team/app', 'fix/1', context())

		// Assert
		expect(head).toBe(await remote.head('fix/1'))
		expect(await remote.files('fix/1')).toEqual(['README.md', 'src/fix.txt'])
		expect(again.branchExists).toBe(true)
	})

	test('settles promptly when the call is stopped while the remote never answers', async () => {
		// Arrange
		const hanging = await hangingServer()
		const host = gitRemote({ directory: await temporaryDirectory(), remoteUrl: () => `${hanging}/team/app.git` })
		const stop = new AbortController()
		const started = Date.now()

		// Act
		const fetching = host.fetchBundle('team/app', 'fix/1', context(stop.signal))
		setTimeout(() => {
			stop.abort(new Error('The run was stopped.'))
		}, 200)

		// Assert
		await expect(fetching).rejects.toThrow('The run was stopped.')
		expect(Date.now() - started).toBeLessThan(promptlyMs)
	})

	test('keeps the token out of the arguments and sends it as a header', async () => {
		// Arrange
		const seen: string[] = []
		const server = await hangingServer((authorization) => {
			seen.push(authorization)
		})
		const host = gitRemote({ directory: await temporaryDirectory(), remoteUrl: () => `${server}/team/app.git` })
		const stop = new AbortController()

		// Act
		const fetching = host.fetchBundle('team/app', 'fix/1', context(stop.signal))
		await expect.poll(() => seen.length).toBeGreaterThan(0)
		stop.abort(new Error('Seen enough.'))
		await fetching.catch(() => undefined)

		// Assert
		expect(seen[0]).toBe(`Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`)
	})
})

/** An HTTP server that takes every request and never answers it, reporting the `Authorization` header it saw. */
async function hangingServer(onRequest: (authorization: string) => void = () => undefined): Promise<string> {
	const server: Server = createServer((request) => {
		onRequest(request.headers.authorization ?? '')
	})
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve)
	})
	onTestFinished(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => {
					resolve()
				})
				server.closeAllConnections()
			}),
	)
	const address = server.address()
	if (address === null || typeof address === 'string') throw new Error('No port.')
	return `http://127.0.0.1:${String(address.port)}`
}
