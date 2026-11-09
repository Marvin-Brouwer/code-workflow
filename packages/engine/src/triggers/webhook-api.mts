import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { Engine } from '../engine/engine.mts'
import { EngineError } from '../engine/engine-error.mts'
import { messageOf } from '../errors.mts'
import type { RepositoryStore } from '../repositories/repository-store.mts'
import { payloadProblems } from './payload-problems.mts'
import { signatureFits } from './signature-fits.mts'
import type { WebhookSecrets } from './webhook-secrets.mts'

/** What the webhook ingress needs. */
export interface WebhookApiOptions {
	readonly engine: Engine
	readonly repositories: RepositoryStore
	readonly secrets: WebhookSecrets
	/** Where the details of a refused delivery go; the sender only gets a short answer. */
	readonly log: (message: string) => void
}

/** The largest delivery taken. GitHub sends up to 25 MB; a payload that size is never a workflow's parameters. */
const maxBodyBytes = 25 * 1024 * 1024

/** The longest delivery name taken from a header. */
const maxDeliveryNameLength = 200

/** The route a repository's webhook is delivered to. */
export function webhookPath(repository: string, webhook: string): string {
	return `/webhooks/${encodeURIComponent(repository)}/${encodeURIComponent(webhook)}`
}

/**
 * The webhook ingress: `POST /webhooks/:repository/:webhook` starts a run for a delivery to a
 * webhook trigger in a registered repository's entry file. Everything is checked on the host before
 * a sandbox is made, in this order:
 *
 * | Check | Answer when it fails |
 * |---|---|
 * | the repository is registered and the entry file has the webhook | 404 |
 * | a secret is set and the delivery is signed with it | 401 |
 * | the body is JSON | 400 |
 * | the payload fits the input side of the trigger's schema, as JSON Schema | 422 |
 *
 * A delivery that passes gets 202 and a new run, named by its delivery id; a redelivery gets 200
 * and the run it started before. The run then applies the schema's `.refine` and `.transform` in
 * the sandbox, and ends as skipped when they turn the delivery down.
 */
export function webhookApi(options: WebhookApiOptions): Hono {
	const { engine, repositories, secrets, log } = options
	const app = new Hono()
	const refuse = (c: Context, status: 401 | 404, error: string, detail: string) => {
		log(`Refused a delivery to ${c.req.path}: ${detail}`)
		return c.json({ error }, status)
	}

	app.post(
		'/webhooks/:repository/:webhook',
		bodyLimit({ maxSize: maxBodyBytes, onError: (c) => c.json({ error: 'The delivery is too large.' }, 413) }),
		async (c) => {
			const name = c.req.param('repository')
			const id = c.req.param('webhook')
			const signal = c.req.raw.signal
			const repository = await repositories.get(name)
			if (repository === undefined) return refuse(c, 404, 'There is no such webhook.', `no repository ${name} is registered.`)
			const secret = await secrets.get(repository.name, id)
			if (secret === undefined) {
				return refuse(c, 401, 'The signature does not fit.', `no secret is set; set one with \`mesh-flow webhook secret ${name} ${id}\`.`)
			}
			const description = await engine.describe(repository.directory, signal)
			const trigger = description.triggers.find((candidate) => candidate.kind === 'webhook' && candidate.id === id)
			if (trigger?.kind !== 'webhook') return refuse(c, 404, 'There is no such webhook.', `the entry file of ${name} has no webhook ${id}.`)
			const body = new Uint8Array(await c.req.arrayBuffer())
			if (!signatureFits(trigger.signature, secret, c.req.raw.headers, body)) {
				return refuse(
					c,
					401,
					'The signature does not fit.',
					`it isn't signed with the secret (${trigger.signature.scheme} in ${trigger.signature.header}).`,
				)
			}

			let payload: unknown
			try {
				payload = JSON.parse(Buffer.from(body).toString('utf8'))
			} catch {
				return c.json({ error: 'The delivery is not JSON.' }, 400)
			}
			const problems = payloadProblems(trigger.payload, payload)
			if (problems.length > 0) return c.json({ error: `The delivery is not for webhook ${id}.`, problems }, 422)

			const key = `webhook ${repository.name}/${id}/${deliveryName(trigger.deliveryHeader, c.req.raw.headers, body)}`
			const known = engine.runWithKey(key)
			if (known !== undefined) return c.json({ run: known.id, status: known.status }, 200)
			const record = await engine.startRun({
				directory: repository.directory,
				workflow: trigger.workflow,
				input: payload,
				trigger: { kind: 'webhook', id, repository: repository.name },
				key,
				signal,
			})
			return c.json({ run: record.id, status: record.status }, 202)
		},
	)

	app.onError((error, c) => {
		if (error instanceof EngineError && error.code === 'conflict') return c.json({ error: 'The engine is shutting down.' }, 503)
		log(`A delivery to ${c.req.path} failed: ${messageOf(error)}`)
		return c.json({ error: 'The delivery could not be handled.' }, 500)
	})
	return app
}

/** What names a delivery: the delivery header's value, or a hash of the body when there is none. */
function deliveryName(header: string | undefined, headers: Headers, body: Uint8Array): string {
	const named = header === undefined ? null : headers.get(header)
	if (named !== null && named.length > 0 && named.length <= maxDeliveryNameLength) return named
	return `sha256:${createHash('sha256').update(body).digest('hex')}`
}
