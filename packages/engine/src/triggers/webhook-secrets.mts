import { CredentialName, type CredentialStore } from '@mesh-flow/gateway'

/**
 * The secrets webhooks are signed with, by webhook, in the gateway's credential store as
 * `webhook/<webhook>`. Never in the app. The CLI sets them and the engine reads them on every
 * delivery, so a new secret works at once.
 */
export interface WebhookSecrets {
	get(webhook: string, abortSignal: AbortSignal): Promise<string | undefined>
	set(webhook: string, secret: string, abortSignal: AbortSignal): Promise<void>
}

/** The name a webhook's secret has in the credential store. */
function webhookCredential(webhook: string): string {
	return `webhook/${webhook}`
}

/** The webhook secrets in the gateway's credential store. */
export function openWebhookSecrets(credentials: CredentialStore): WebhookSecrets {
	return Object.freeze<WebhookSecrets>({
		async get(webhook, abortSignal) {
			// A name no credential can have, as from a request to any URL, has no secret.
			const name = CredentialName.safeParse(webhookCredential(webhook))
			return name.success ? credentials.get(name.data, abortSignal) : undefined
		},
		set: (webhook, secret, abortSignal) => credentials.set(webhookCredential(webhook), secret, abortSignal),
	})
}
