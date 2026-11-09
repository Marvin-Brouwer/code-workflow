import { text } from 'node:stream/consumers'
import type { GatewayHome } from '@mesh-flow/gateway'
import type { Command } from 'commander'

/** How long a credential command may take: it only reads and writes files in the engine's home. */
const credentialCommandMs = 30_000

function signal(): AbortSignal {
	return AbortSignal.timeout(credentialCommandMs)
}

/**
 * `mesh-flow credential ...`: the gateway's credential store, for what isn't a provider key or a
 * webhook secret, such as a connector's token. Secrets come from stdin, never from
 * an argument, so they stay out of the shell's history.
 */
export function addCredentialCommands(program: Command, gateway: (abortSignal: AbortSignal) => Promise<GatewayHome>): void {
	const credential = program.command('credential').description("The gateway's credentials. They stay on this machine, sealed.")

	credential
		.command('set')
		.description('Sets a credential, read from stdin.')
		.argument('<name>', 'such as github/token')
		.action(async (name: string) => {
			const abortSignal = signal()
			const secret = (await text(process.stdin)).trim()
			if (secret.length === 0) throw new Error('No secret on stdin. Pipe one in.')
			await (await gateway(abortSignal)).credentials.set(name, secret, abortSignal)
		})

	credential
		.command('list')
		.description('Lists the names of the credentials, never their secrets.')
		.action(async () => {
			const abortSignal = signal()
			for (const name of await (await gateway(abortSignal)).credentials.names(abortSignal)) console.log(name)
		})

	credential
		.command('remove')
		.description('Removes a credential.')
		.argument('<name>')
		.action(async (name: string) => {
			const abortSignal = signal()
			if (!(await (await gateway(abortSignal)).credentials.remove(name, abortSignal))) throw new Error(`There is no credential ${name}.`)
		})
}
