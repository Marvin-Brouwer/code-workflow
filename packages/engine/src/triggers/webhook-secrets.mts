import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { CredentialName, type CredentialStore } from '@mesh-flow/gateway'
import { z } from 'zod'
import { hasErrorCode } from '../errors.mts'

/**
 * The secrets webhooks are signed with, by app and webhook, in the gateway's credential store as
 * `webhook/<app>/<webhook>`. Never in the app. The CLI sets them and the engine reads them on every
 * delivery, so a new secret works at once.
 */
export interface WebhookSecrets {
	get(app: string, webhook: string, abortSignal: AbortSignal): Promise<string | undefined>
	set(app: string, webhook: string, secret: string, abortSignal: AbortSignal): Promise<void>
}

/** The name a webhook's secret has in the credential store. */
function webhookCredential(app: string, webhook: string): string {
	return `webhook/${app}/${webhook}`
}

/** The webhook secrets in the gateway's credential store. */
export function openWebhookSecrets(credentials: CredentialStore): WebhookSecrets {
	return Object.freeze<WebhookSecrets>({
		async get(app, webhook, abortSignal) {
			// A name no credential can have, as from a request to any URL, has no secret.
			const name = CredentialName.safeParse(webhookCredential(app, webhook))
			return name.success ? credentials.get(name.data, abortSignal) : undefined
		},
		set: (app, webhook, secret, abortSignal) => credentials.set(webhookCredential(app, webhook), secret, abortSignal),
	})
}

const LegacySecrets = z.record(z.string(), z.string().min(1))

/**
 * Moves the secrets an engine kept in `secrets/webhooks.json` in its home, before the gateway, into
 * the credential store, then removes the file. A secret already in the store stays as it is.
 * Resolves to how many it moved.
 */
export async function moveLegacyWebhookSecrets(home: string, credentials: CredentialStore, abortSignal: AbortSignal): Promise<number> {
	const file = path.join(home, 'secrets', 'webhooks.json')
	const text = await readFile(file, { encoding: 'utf8', signal: abortSignal }).catch((error: unknown) => {
		if (hasErrorCode(error, 'ENOENT')) return undefined
		throw error
	})
	if (text === undefined) return 0
	let moved = 0
	for (const [key, secret] of Object.entries(LegacySecrets.parse(JSON.parse(text)))) {
		const parts = key.split('/')
		const [app, webhook] = parts
		if (parts.length !== 2 || app === undefined || webhook === undefined) continue
		const name = webhookCredential(app, webhook)
		if ((await credentials.get(name, abortSignal)) !== undefined) continue
		await credentials.set(name, secret, abortSignal)
		moved++
	}
	await rm(file, { force: true })
	return moved
}
