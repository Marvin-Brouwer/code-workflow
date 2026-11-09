import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import writeFileAtomic from 'write-file-atomic'
import { hasErrorCode } from '../errors.mts'

const Secrets = z.record(z.string(), z.string().min(1))

/**
 * The secrets webhooks are signed with, by repository and webhook, in a file in the engine's home
 * that only its owner can read. Never in the workflow repository. They move to the gateway's
 * credential store once it exists.
 *
 * The CLI writes the file and the engine reads it on every delivery, so a new secret works at once.
 */
export interface WebhookSecrets {
	get(repository: string, webhook: string): Promise<string | undefined>
	set(repository: string, webhook: string, secret: string): Promise<void>
}

/** The file the secrets are kept in, in the engine's home. */
export function webhookSecretsFile(home: string): string {
	return path.join(home, 'secrets', 'webhooks.json')
}

function keyOf(repository: string, webhook: string): string {
	return `${repository}/${webhook}`
}

export function openWebhookSecrets(file: string): WebhookSecrets {
	const read = async () => {
		const text = await readFile(file, 'utf8').catch((error: unknown) => {
			if (hasErrorCode(error, 'ENOENT')) return '{}'
			throw error
		})
		return Secrets.parse(JSON.parse(text))
	}
	return Object.freeze({
		get: async (repository, webhook) => (await read())[keyOf(repository, webhook)],
		async set(repository, webhook, secret) {
			await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
			const secrets = { ...(await read()), [keyOf(repository, webhook)]: secret }
			await writeFileAtomic(file, `${JSON.stringify(secrets, null, '\t')}\n`, { mode: 0o600 })
		},
	} satisfies WebhookSecrets)
}
