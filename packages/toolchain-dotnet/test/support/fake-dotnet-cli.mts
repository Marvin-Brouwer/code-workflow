// A stand-in for the `dotnet` CLI, which `fakeDotnet` runs with `node`: it answers each command as
// the answers in FAKE_DOTNET_SCRIPT say, writes the TRX files it's given into `--results-directory`,
// and logs every call.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

const Answer = z.object({
	stdout: z.string().optional(),
	exitCode: z.number().optional(),
	trx: z.array(z.string()).optional(),
	hang: z.boolean().optional(),
})
const Answers = z.record(z.string(), Answer)

const args = process.argv.slice(2)
const [command = ''] = args
appendFileSync(z.string().parse(process.env.FAKE_DOTNET_LOG), `${JSON.stringify(args)}\n`)
const answers = Answers.parse(JSON.parse(readFileSync(z.string().parse(process.env.FAKE_DOTNET_SCRIPT), 'utf8')))
const answer = answers[command] ?? { exitCode: 0 }
/** Any interval keeps the process alive until it is killed. */
const keepAliveMs = 1000

if (answer.hang === true) setInterval(() => undefined, keepAliveMs)
else {
	const results = args[args.indexOf('--results-directory') + 1] ?? '.'
	for (const [index, trx] of (answer.trx ?? []).entries()) writeFileSync(path.join(results, `run-${String(index)}.trx`), trx)
	process.stdout.write(answer.stdout ?? '')
	process.exitCode = answer.exitCode ?? 0
}
