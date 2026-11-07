import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'vitest'
import { initCommand, jobDirectory, jobFifo, jobScript, submitJobCommand } from '../../src/gvisor/init.mts'
import { egressMountPoint } from '../../src/gvisor/layout.mts'
import { temporaryDirectory } from '../support/temporary-directory.mts'

const run = promisify(execFile)

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

/** Runs `submitJobCommand` on the host, against a FIFO in `directory` instead of the sandbox's. */
async function submit(directory: string, options: Parameters<typeof submitJobCommand>[1], fifo = true) {
	const job = path.join(directory, 'job.sh')
	await writeFile(job, 'true\n')
	const [program, ...args] = submitJobCommand(job, options)
	const fifoPath = path.join(directory, 'start')
	if (fifo) await run('mkfifo', [fifoPath])
	const reading = fifo ? readFile(fifoPath, 'utf8') : Promise.resolve('')
	const submitting = run(
		program,
		args.map((arg) => (arg === jobFifo ? fifoPath : arg)),
	)
	return { job, submitting, reading }
}

describe('submitJobCommand', () => {
	test('hands the job to init', async () => {
		// Arrange
		const directory = await temporaryDirectory()

		// Act
		const { job, submitting, reading } = await submit(directory, { cwd: directory, logFile: path.join(directory, 'job.log') })

		// Assert
		await expect(submitting).resolves.toBeDefined()
		expect(await reading).toBe(`${job}\n`)
	})

	test('fails, and removes the job, when its directory is missing', async () => {
		// Arrange
		const directory = await temporaryDirectory()

		// Act
		const { job, submitting } = await submit(directory, { cwd: path.join(directory, 'missing') }, false)

		// Assert
		await expect(submitting).rejects.toThrow()
		await expect(readFile(job, 'utf8')).rejects.toThrow('ENOENT')
	})

	test('fails when the log file cannot be written', async () => {
		// Arrange
		const directory = await temporaryDirectory()

		// Act
		const { submitting } = await submit(directory, { logFile: path.join(directory, 'missing', 'job.log') }, false)

		// Assert
		await expect(submitting).rejects.toThrow()
	})
})
