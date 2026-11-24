import type { Command } from 'commander'
import { importServeUi } from '../ui/ui-host.mts'

/** The port `mesh-flow ui` takes when `--port` doesn't say: a free one. */
const anyFreePort = 0

/**
 * `mesh-flow ui`: serves the UI on 127.0.0.1 from `@mesh-flow/ui`, installed where `mesh-flow`
 * runs, and opens it. Ctrl+C stops it.
 */
export function addUiCommand(
	program: Command,
	settings: () => { readonly home: string; readonly keychain: boolean },
	parsePort: (value: string) => number,
): void {
	program
		.command('ui')
		.description('Serves the UI on 127.0.0.1 and opens it. Needs @mesh-flow/ui installed here. Ctrl+C stops it.')
		.option('--port <port>', 'the port (default: a free one)', parsePort, anyFreePort)
		.option('--no-open', 'only prints the address')
		.action(async (options: { port: number; open: boolean }) => {
			const serveUi = await importServeUi(process.cwd())
			const stopping = new AbortController()
			process.once('SIGINT', () => {
				stopping.abort(new Error('Stopped.'))
			})
			const served = await serveUi({ ...settings(), ...options, abortSignal: stopping.signal })
			console.error(`The UI is on ${served.url}`)
			await served.closed
		})
}
