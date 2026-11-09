import { text } from 'node:stream/consumers'
import type { GatewayHome } from '@mesh-flow/gateway'
import type { Command } from 'commander'
import { homeCommandAbortSignal } from './home-command-abort-signal.mts'

/**
 * `mesh-flow credential ...`: the gateway's credential store, for what isn't a provider key or a
 * webhook secret, such as a connector's token. Secrets come from stdin, never from
 * an argument, so they stay out of the shell's history.
 */
export function addCredentialCommands(program: Command, gatewayHome: (abortSignal: AbortSignal) => Promise<GatewayHome>): void {
	const credential = program.command('credential').description("The gateway's credentials. They stay on this machine, sealed.")

	credential
		.command('set')
		.description('Sets a credential, read from stdin.')
		.argument('<name>', 'such as github/token')
		.action(async (name: string) => {
			const secret = (await text(process.stdin)).trim()
			if (secret.length === 0) throw new Error('No secret on stdin. Pipe one in.')
			// Started once the secret is in, so typing it doesn't use up the time.
			const abortSignal = homeCommandAbortSignal()
			await (await gatewayHome(abortSignal)).credentials.set(name, secret, abortSignal)
		})

	credential
		.command('list')
		.description('Lists the names of the credentials, never their secrets.')
		.action(async () => {
			const abortSignal = homeCommandAbortSignal()
			for (const name of await (await gatewayHome(abortSignal)).credentials.names(abortSignal)) console.log(name)
		})

	credential
		.command('remove')
		.description('Removes a credential.')
		.argument('<name>')
		.action(async (name: string) => {
			const abortSignal = homeCommandAbortSignal()
			if (!(await (await gatewayHome(abortSignal)).credentials.remove(name, abortSignal)))
				throw new Error(`There is no credential ${name}.`)
		})
}
