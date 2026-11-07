import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
import { initCommand, jobDirectory, jobFifo, jobScript, submitJobCommand } from '../../src/gvisor/init.mts'
import { egressMountPoint } from '../../src/gvisor/layout.mts'
import { temporaryDirectory } from '../support/temporary-directory.mts'

const execFileAsync = promisify(execFile)

/** Runs a command on the host. A command that blocks on the FIFO fails after a few seconds. */
function run(program: string, args: readonly string[]) {
	return execFileAsync(program, args, { timeout: 5000 })
}

/** What a command that had to fail wrote to stderr. */
async function stderrOf(running: Promise<unknown>): Promise<string> {
	const error = await running.then(
		() => undefined,
		(caught: unknown) => caught,
	)
	if (!(error instanceof Error) || !('stderr' in error) || typeof error.stderr !== 'string') {
		throw new Error('The command should have failed with output on stderr.')
	}
	return error.stderr
}

interface Submission {
	readonly job: string
	readonly fifo: string
	readonly command: [string, string[]]
}

/** `submitJobCommand` for the host: a job in `directory`, and a FIFO there instead of the sandbox's. */
async function submission(
	directory: string,
	options: Parameters<typeof submitJobCommand>[1],
	{ fifo: withFifo = true } = {},
): Promise<Submission> {
	const job = path.join(directory, 'job.sh')
	const fifo = path.join(directory, 'start')
	await writeFile(job, 'true\n')
	if (withFifo) await run('mkfifo', [fifo])
	const [program, ...args] = submitJobCommand(job, options)
	return { job, fifo, command: [program, args.map((arg) => (arg === jobFifo ? fifo : arg))] }
}

describe('jobScript', () => {
	test('runs the command with its arguments, environment and directory untouched', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const job = path.join(directory, 'job.sh')
		const log = path.join(directory, 'job.log')
		const script = jobScript(['sh', '-c', 'echo "$1|$NAME|$PWD"', 'sh', "it's $HOME"], {
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
		await writeFile(job, jobScript(['true'], {}))

		// Act
		await run('sh', [job])

		// Assert
		await expect(readFile(job, 'utf8')).rejects.toThrow('ENOENT')
	})

	test('refuses an environment variable name the shell would read as code', () => {
		// Act and assert
		expect(() => jobScript(['true'], { env: { 'A=$(reboot)': 'x' } })).toThrow('A=$(reboot) is not a valid environment variable name.')
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

	test('keeps its jobs out of the read-only egress mount', () => {
		// Assert
		expect(`${jobDirectory}/`.startsWith(`${egressMountPoint}/`)).toBe(false)
	})
})

describe('submitJobCommand', () => {
	test('hands the job to init', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const { job, fifo, command } = await submission(directory, { cwd: directory, logFile: path.join(directory, 'job.log') })
		const reading = readFile(fifo, 'utf8')

		// Act
		await run(...command)

		// Assert
		expect(await reading).toBe(`${job}\n`)
	})

	test('fails, and removes the job, when its directory is missing', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const { job, command } = await submission(directory, { cwd: path.join(directory, 'missing') })

		// Act
		const submitting = run(...command)

		// Assert
		expect(await stderrOf(submitting)).toContain(path.join(directory, 'missing'))
		await expect(readFile(job, 'utf8')).rejects.toThrow('ENOENT')
	})

	test('fails when the log file cannot be written', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const { command } = await submission(directory, { logFile: path.join(directory, 'missing', 'job.log') })

		// Act
		const submitting = run(...command)

		// Assert
		expect(await stderrOf(submitting)).toContain('job.log')
	})

	test('fails when init is not taking jobs', async () => {
		// Arrange
		const directory = await temporaryDirectory()
		const { command } = await submission(directory, {}, { fifo: false })

		// Act
		const submitting = run(...command)

		// Assert
		expect(await stderrOf(submitting)).toBe("The sandbox's init isn't taking jobs.\n")
	})
})
