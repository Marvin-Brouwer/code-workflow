import path from 'node:path'
import { keyFile, openCredentialStore, type CredentialStore } from '@mesh-flow/gateway'
import { Command } from 'commander'
import { describe, expect, test, vi } from 'vitest'
import { addLoginCommand } from '../src/cli/login-command.mts'
import type { LoadedConnector, LoginContext } from '../src/connectors/load-connectors.mts'
import { ControlError, type ControlClient } from '../src/control/control-client.mts'
import type { SignInState } from '../src/engine/sign-ins.mts'
import { temporaryDirectory } from './support/temporary-directory.mts'

const abortSignal = new AbortController().signal

/** How long the command may take to settle once stopped, while the sign-in never does. */
const promptlyMs = 3_000

const prompt = { url: 'https://device.example/?user_code=ABCD-EFGH', code: 'ABCD-EFGH', expiresAt: new Date('2026-11-16T09:10:00Z') }

type EngineSignIns = Pick<ControlClient, 'signIns' | 'signIn'>

/** No engine serves: every call says so, as the control client does. */
const noEngine: EngineSignIns = {
	signIns: () => Promise.reject(new ControlError('No engine is running. Start one with `mesh-flow serve`.')),
	signIn: () => Promise.reject(new ControlError('No engine is running. Start one with `mesh-flow serve`.')),
}

/** The command line with only `login`, over `connectors` and `engine`, and what it logged. */
async function loginProgram(connectors: (credentials: CredentialStore) => readonly LoadedConnector[], engine = noEngine) {
	const home = await temporaryDirectory()
	const credentials = openCredentialStore(path.join(home, 'credentials.json'), keyFile(path.join(home, 'store.key')))
	const lines: string[] = []
	const program = new Command('mesh-flow').exitOverride()
	addLoginCommand(program, {
		credentials: () => Promise.resolve(credentials),
		connectors: (store) => Promise.resolve(connectors(store)),
		engine: () => engine,
		log: (line) => lines.push(line),
	})
	return { program, lines, credentials }
}

describe('mesh-flow login', () => {
	test("runs the connector's sign-in when no engine serves, and shows where to sign in", async () => {
		// Arrange
		const { program, lines, credentials } = await loginProgram((store) => [
			{
				package: '@team/cloud',
				name: 'cloud',
				tools: [],
				login: (context: LoginContext) => {
					context.show(prompt)
					return store.set('cloud/session', 'token', context.abortSignal)
				},
			},
		])

		// Act
		await program.parseAsync(['login', 'cloud'], { from: 'user' })

		// Assert
		expect(await credentials.get('cloud/session', abortSignal)).toBe('token')
		expect(lines.join('\n')).toContain(prompt.url)
		expect(lines.join('\n')).toContain(prompt.code)
		expect(lines.at(-1)).toBe('Signed in to cloud.')
	})

	test("joins the serving engine's sign-in and shows its code once", async () => {
		// Arrange
		const shown: SignInState = { connector: 'cloud', prompt: { ...prompt, expiresAt: prompt.expiresAt.toISOString() } }
		const { promise: approved, resolve: approve } = Promise.withResolvers<undefined>()
		const signIns = vi.fn(() => Promise.resolve([shown]))
		const engine: EngineSignIns = { signIns, signIn: () => approved }
		const login = vi.fn(() => Promise.resolve())
		const { program, lines } = await loginProgram(() => [{ package: '@team/cloud', name: 'cloud', tools: [], login }], engine)

		// Act
		const loggingIn = program.parseAsync(['login', 'cloud'], { from: 'user' })
		await vi.waitFor(
			() => {
				expect(signIns.mock.calls.length).toBeGreaterThan(2)
			},
			{ timeout: 5_000 },
		)
		approve(undefined)
		await loggingIn

		// Assert
		expect(lines.filter((line) => line.includes(prompt.code))).toHaveLength(1)
		expect(lines.at(-1)).toBe('Signed in to cloud.')
		expect(login).not.toHaveBeenCalled()
	})

	test('names the connectors there are when the one asked for is not added', async () => {
		// Arrange
		const { program } = await loginProgram(() => [{ package: 'tracker', name: 'tracker', tools: [] }])

		// Act
		const loggingIn = program.parseAsync(['login', 'cloud'], { from: 'user' })

		// Assert
		await expect(loggingIn).rejects.toThrow('Added connectors: tracker')
	})

	test('says when a connector has nothing to sign in to', async () => {
		// Arrange
		const { program } = await loginProgram(() => [{ package: 'tracker', name: 'tracker', tools: [] }])

		// Act
		const loggingIn = program.parseAsync(['login', 'tracker'], { from: 'user' })

		// Assert
		await expect(loggingIn).rejects.toThrow('nothing to sign in to')
	})

	test('stops waiting on Ctrl+C while the sign-in never settles, and lets go of Ctrl+C', async () => {
		// Arrange
		const started = vi.fn<() => void>()
		const login = (context: LoginContext) =>
			new Promise<void>((_resolve, reject) => {
				context.abortSignal.addEventListener('abort', () => {
					reject(context.abortSignal.reason)
				})
				started()
			})
		const listeners = process.listenerCount('SIGINT')
		const { program } = await loginProgram(() => [{ package: '@team/cloud', name: 'cloud', tools: [], login }])
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
