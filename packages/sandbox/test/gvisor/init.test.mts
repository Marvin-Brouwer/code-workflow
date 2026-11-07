import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
import { initCommand, jobScript } from '../../src/gvisor/init.mts'
import { temporaryDirectory } from '../support/temporary-directory.mts'

const run = promisify(execFile)

describe('jobScript', () => {
	test('runs the command with its arguments, environment and directory untouched', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const job = path.join(directory, 'job.sh')
		const log = path.join(directory, 'job.log')
		const script = jobScript(['sh', '-c', 'echo "$1|$NAME|$PWD"', 'sh', "it's $HOME"], {
			signal: AbortSignal.timeout(5000),
			env: { NAME: 'a "quoted" value' },
			cwd: directory,
			logFile: log,
		})
		await writeFile(job, script)

		// Act
		await run('sh', [job])

		// Assert
		expect(await readFile(log, 'utf8')).toBe(`it's $HOME|a "quoted" value|${directory}\n`)
	})

	test('removes itself', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const job = path.join(directory, 'job.sh')
		await writeFile(job, jobScript(['true'], { signal: AbortSignal.timeout(5000) }))

		// Act
		await run('sh', [job])

		// Assert
		await expect(readFile(job, 'utf8')).rejects.toThrow('ENOENT')
	})

	test('refuses an environment variable name the shell would read as code', () => {
		// Act and assert
		expect(() => jobScript(['true'], { signal: AbortSignal.timeout(5000), env: { 'A=$(reboot)': 'x' } })).toThrow(
			'A=$(reboot) is not a valid environment variable name.',
		)
	})
})

describe('initCommand', () => {
	test('passes the service to a script the shell accepts', async () => {
		// Act
		const [program, flag, script, ...args] = initCommand(['node', '-e', 'forward()'])

		// Assert
		expect([program, flag]).toEqual(['sh', '-c'])
		expect(args).toEqual(['sh', 'node', '-e', 'forward()'])
		await expect(run('sh', ['-n', '-c', script ?? ''])).resolves.toBeDefined()
	})
})
