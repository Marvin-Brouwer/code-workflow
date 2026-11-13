// A stand-in for the `dotnet` CLI, which `fakeDotnet` runs with `node`: it answers each command as
// the answers in FAKE_DOTNET_SCRIPT say, writes the TRX files it's given into `--results-directory`,
// and logs every call.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const Answer = z.object({
	stdout: z.string().optional(),
	exitCode: z.number().optional(),
	trx: z.array(z.string()).optional(),
	hang: z.boolean().optional(),
	holdMs: z.number().optional(),
	stubbornChildPidFile: z.string().optional(),
	ignoresStop: z.boolean().optional(),
	pidFile: z.string().optional(),
	killedWith: z.string().optional(),
})
const Answers = z.record(z.string(), Answer)

const args = process.argv.slice(2)
const [command = ''] = args
appendFileSync(z.string().parse(process.env.FAKE_DOTNET_LOG), `${JSON.stringify(args)}\n`)
const answers = Answers.parse(JSON.parse(readFileSync(z.string().parse(process.env.FAKE_DOTNET_SCRIPT), 'utf8')))
const answer = answers[command] ?? { exitCode: 0 }
/** Any interval keeps the process alive until it is killed. */
const keepAliveMs = 1000

/** A process that ignores SIGTERM, with output of its own, as a test host stuck in its exit handlers. */
const stubbornChild = `process.on('SIGTERM', () => undefined); setInterval(() => undefined, ${String(keepAliveMs)})`

if (answer.ignoresStop === true) process.on('SIGTERM', () => undefined)
if (answer.pidFile !== undefined) writeFileSync(answer.pidFile, String(process.pid))
if (answer.stubbornChildPidFile !== undefined) {
	const child = spawn(process.execPath, ['-e', stubbornChild], { stdio: 'ignore' })
	writeFileSync(answer.stubbornChildPidFile, String(child.pid))
}

if (answer.killedWith !== undefined) process.kill(process.pid, answer.killedWith)
else if (answer.hang === true) setInterval(() => undefined, keepAliveMs)
else if (answer.holdMs !== undefined) setTimeout(() => process.exit(answer.exitCode ?? 0), answer.holdMs)
else {
	const results = args[args.indexOf('--results-directory') + 1] ?? '.'
	for (const [index, trx] of (answer.trx ?? []).entries()) writeFileSync(path.join(results, `run-${String(index)}.trx`), trx)
	process.stdout.write(answer.stdout ?? '')
	process.exitCode = answer.exitCode ?? 0
}
