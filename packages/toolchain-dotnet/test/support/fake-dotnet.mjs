// A stand-in for the `dotnet` CLI: it answers each command as the script in FAKE_DOTNET_SCRIPT
// says, writes the TRX files it's given into `--results-directory`, and logs every call.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const [command] = args
appendFileSync(process.env.FAKE_DOTNET_LOG, `${JSON.stringify(args)}\n`)
const script = JSON.parse(readFileSync(process.env.FAKE_DOTNET_SCRIPT, 'utf8'))
const answer = script[command] ?? { exitCode: 0 }
if (answer.hang) setInterval(() => undefined, 1000)
else {
	const results = args.indexOf('--results-directory')
	for (const [index, trx] of (answer.trx ?? []).entries()) writeFileSync(path.join(args[results + 1], `run-${String(index)}.trx`), trx)
	process.stdout.write(answer.stdout ?? '')
	process.exitCode = answer.exitCode ?? 0
}
