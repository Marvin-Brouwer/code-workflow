import path from 'node:path'
import { keyFile, openCredentialStore, openProviderSettings, type ConnectorLoginContext } from '@mesh-flow/gateway'
import { Command } from 'commander'
import { describe, expect, test, vi } from 'vitest'
import { addLoginCommand } from '../src/cli/login-command.mts'
import type { LoadedConnector } from '../src/connectors/load-connectors.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

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
		const login = vi.fn((context: ConnectorLoginContext) => {
			context.show(prompt)
			return context.credentials.set('cloud/session', 'token', context.abortSignal)
		})
		const { program, lines, credentials } = await loginProgram([{ package: '@team/cloud', name: 'cloud', tools: [], login }])

		// Act
		await program.parseAsync(['login', 'cloud'], { from: 'user' })

		// Assert
		expect(await credentials.get('cloud/session', new AbortController().signal)).toBe('token')
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
})
