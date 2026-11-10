import { createServer, type Server } from 'node:http'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, onTestFinished, test } from 'vitest'
import { basicAuthHeaderEnv } from '../src/auth.mts'
import { gitClient } from '../src/git-client.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const identity = { 'user.name': 'Test', 'user.email': 'test@example.com' }

/** How long a stopped command may take to settle while git hangs. */
const promptlyMs = 3_000

/** How long git may take to reach the server: a few processes in a row take seconds on a slow runner. */
const reachesServerWithinMs = 15_000

/** A repository with one commit on `main`. */
async function repository(abortSignal = new AbortController().signal) {
	const directory = await temporaryDirectory()
	const git = gitClient({ cwd: directory, config: identity, abortSignal })
	await git.init({ branch: 'main', quiet: true })
	await writeFile(path.join(directory, 'README.md'), '# Example\n')
	await git.add()
	await git.commit({ message: 'Start', quiet: true })
	return git
}

describe('gitClient', () => {
	test('runs a command when awaited, and fails on a non-zero exit with the command in the error', async () => {
		// Arrange
		const git = await repository()

		// Act
		const head = await git.revParse('HEAD')
		const missing = git.revParse('--verify', 'refs/heads/nowhere')

		// Assert
		expect(head.ok).toBe(true)
		expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)
		await expect(missing).rejects.toThrow('`git rev-parse --verify refs/heads/nowhere` failed (exit 128)')
	})

	test('hands the exit back from run(), swallows it in attempt(), and renders without running', async () => {
		// Arrange
		const git = await repository()

		// Act
		const asked = await git.showRef('refs/heads/nowhere').run()
		await git.rebaseAbort().attempt()
		const line = String(git.checkout('fix/7', { create: true, from: 'main' }))

		// Assert
		expect(asked).toMatchObject({
			ok: false,
			exitCode: 1,
			command: [
				'git',
				'-c',
				'user.name=Test',
				'-c',
				'user.email=test@example.com',
				'show-ref',
				'--verify',
				'--quiet',
				'refs/heads/nowhere',
			],
		})
		expect(line).toBe('git checkout -b fix/7 main')
		expect(await git.hasBranch('fix/7')).toBe(false)
	})

	test('answers the questions a workflow asks about a checkout', async () => {
		// Arrange
		const git = await repository()

		// Act
		await git.checkoutOrCreate('fix/7', 'main')
		await writeFile(path.join(git.cwd, 'fix.txt'), 'fixed\n')
		const dirty = await git.dirtyFiles()
		await git.checkoutOrCreate('main', 'main')

		// Assert
		expect(await git.hasBranch('fix/7')).toBe(true)
		expect(await git.hasRemoteBranch('fix/7')).toBe(false)
		expect(dirty).toEqual(['?? fix.txt'])
		expect(await git.currentBranch()).toBe('main')
		expect(await git.conflictedFiles()).toEqual([])
	})

	test('settles promptly when stopped while the remote never answers', async () => {
		// Arrange
		const hanging = await hangingServer()
		const stop = new AbortController()
		const git = await repository(stop.signal)
		const started = Date.now()

		// Act
		const fetching = git.fetch(`${hanging}/team/app.git`, ['main'])
		setTimeout(() => {
			stop.abort(new Error('The run was stopped.'))
		}, 200)

		// Assert
		await expect(fetching).rejects.toThrow('The run was stopped.')
		expect(Date.now() - started).toBeLessThan(promptlyMs)
	})

	test('sends a credential as a header through the environment, never in the arguments', async () => {
		// Arrange
		const seen: string[] = []
		const server = await hangingServer((authorization) => {
			seen.push(authorization)
		})
		const stop = new AbortController()
		const git = gitClient({
			cwd: await temporaryDirectory(),
			env: basicAuthHeaderEnv('x-access-token', 'ghp_test'),
			abortSignal: stop.signal,
		})
		await git.init({ bare: true, quiet: true })

		// Act
		const command = git.fetch(`${server}/team/app.git`, ['main'])
		const fetching = command.run().catch(() => undefined)
		await expect.poll(() => seen.length, { timeout: reachesServerWithinMs }).toBeGreaterThan(0)
		stop.abort(new Error('Seen enough.'))
		await fetching

		// Assert
		expect(seen[0]).toBe(`Basic ${Buffer.from('x-access-token:ghp_test').toString('base64')}`)
		expect(command.args.join(' ')).not.toContain('ghp_test')
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
