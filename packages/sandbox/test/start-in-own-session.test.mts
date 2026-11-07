import { describe, expect, test } from 'vitest'
import type { Command, ExecOptions, ExecResult, Sandbox } from '../src/sandbox.mts'
import { startInOwnSession } from '../src/start-in-own-session.mts'

function recordingSandbox(result: ExecResult): { sandbox: Pick<Sandbox, 'exec'>; commands: Command[] } {
	const commands: Command[] = []
	const sandbox = {
		exec(command: Command, _options: ExecOptions) {
			commands.push(command)
			return Promise.resolve(result)
		},
	}
	return { sandbox, commands }
}

describe('startInOwnSession', () => {
	test('starts the command in its own session, with its arguments untouched', async () => {
		// Arrange
		const { sandbox, commands } = recordingSandbox({ exitCode: 0, stdout: '', stderr: '' })

		// Act
		await startInOwnSession(sandbox, ['node', 'runtime.mjs', '--name', "it's"], {
			signal: AbortSignal.timeout(1000),
			logFile: '/var/log/runtime.log',
		})

		// Assert
		expect(commands).toEqual([
			[
				'sh',
				'-c',
				'log=$1; shift; exec setsid -f "$@" > "$log" 2>&1 < /dev/null',
				'sh',
				'/var/log/runtime.log',
				'node',
				'runtime.mjs',
				'--name',
				"it's",
			],
		])
	})

	test('throws with stderr when the command could not be started', async () => {
		// Arrange
		const { sandbox } = recordingSandbox({ exitCode: 127, stdout: '', stderr: 'setsid: not found\n' })

		// Act
		const starting = startInOwnSession(sandbox, ['node'], { signal: AbortSignal.timeout(1000) })

		// Assert
		await expect(starting).rejects.toThrow('Starting node failed with exit code 127: setsid: not found')
	})
})
