import path from 'node:path'
import { keyFile, openCredentialStore, openProviderSettings, type ConnectorLoginContext } from '@mesh-flow/gateway'
import { Command } from 'commander'
import { describe, expect, test, vi } from 'vitest'
import { addLoginCommand } from '../src/cli/login-command.mts'
import type { LoadedConnector } from '../src/connectors/load-connectors.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

/** How long the command may take to settle once stopped, while the sign-in never does. */
const promptlyMs = 3_000

const prompt = { url: 'https://device.example/?user_code=ABCD-EFGH', code: 'ABCD-EFGH', expiresAt: new Date('2026-11-16T09:10:00Z') }

/** The command line with only `login`, over `connectors`, and what it logged. */
async function loginProgram(connectors: readonly LoadedConnector[]) {
	const home = await temporaryDirectory()
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	const lines: string[] = []
	const program = new Command('mesh-flow').exitOverride()
	addLoginCommand(program, {
		gatewayHome: () =>
			Promise.resolve({
				directory: home,
				credentials,
				providers: openProviderSettings(path.join(home, 'providers.json')),
				keyLocation: home,
			}),
		connectors: () => Promise.resolve(connectors),
		log: (line) => lines.push(line),
	})
	return { program, lines, credentials }
}

describe('mesh-flow login', () => {
	test("runs the connector's sign-in with the gateway's credentials, and shows where to sign in", async () => {
		// Arrange
		const login = (context: ConnectorLoginContext) => {
			context.show(prompt)
			return context.credentials.set('cloud/session', 'token', context.abortSignal)
		}
		const { program, lines, credentials } = await loginProgram([{ package: '@team/cloud', name: 'cloud', tools: [], login }])

		// Act
		await program.parseAsync(['login', 'cloud'], { from: 'user' })

		// Assert
		expect(await credentials.get('cloud/session', abortSignal)).toBe('token')
		expect(lines.join('\n')).toContain(prompt.url)
		expect(lines.join('\n')).toContain(prompt.code)
		expect(lines.at(-1)).toBe('Signed in to cloud.')
	})

	test('names the connectors there are when the one asked for is not added', async () => {
		// Arrange
		const { program } = await loginProgram([{ package: 'tracker', name: 'tracker', tools: [] }])

		// Act
		const loggingIn = program.parseAsync(['login', 'cloud'], { from: 'user' })

		// Assert
		await expect(loggingIn).rejects.toThrow('Added connectors: tracker')
	})

	test('says when a connector has nothing to sign in to', async () => {
		// Arrange
		const { program } = await loginProgram([{ package: 'tracker', name: 'tracker', tools: [] }])

		// Act
		const loggingIn = program.parseAsync(['login', 'tracker'], { from: 'user' })

		// Assert
		await expect(loggingIn).rejects.toThrow('nothing to sign in to')
	})

	test('stops waiting on Ctrl+C while the sign-in never settles, and lets go of Ctrl+C', async () => {
		// Arrange
		const started = vi.fn<() => void>()
		const login = (context: ConnectorLoginContext) =>
			new Promise<void>((_resolve, reject) => {
				context.abortSignal.addEventListener('abort', () => {
					reject(context.abortSignal.reason)
				})
				started()
			})
		const listeners = process.listenerCount('SIGINT')
		const { program } = await loginProgram([{ package: '@team/cloud', name: 'cloud', tools: [], login }])
		const loggingIn = program.parseAsync(['login', 'cloud'], { from: 'user' })
		loggingIn.catch(() => undefined)
		await vi.waitFor(() => {
			expect(started).toHaveBeenCalled()
		})

		// Act
		const stoppedAt = Date.now()
		process.emit('SIGINT')

		// Assert
		await expect(loggingIn).rejects.toThrow('Stopped waiting for the sign-in.')
		expect(Date.now() - stoppedAt).toBeLessThan(promptlyMs)
		expect(process.listenerCount('SIGINT')).toBe(listeners)
	})
})
