import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppVersion } from '../apps/app-store.mts'
import { startRunTimeoutMs, type Engine } from '../engine/engine.mts'
import { EngineError } from '../engine/engine-error.mts'
import { messageOf } from '../errors.mts'
import { payloadProblems } from './payload-problems.mts'
import { signatureFits } from './signature-fits.mts'
import type { WebhookSecrets } from './webhook-secrets.mts'

/** What the webhook ingress needs. */
export interface WebhookApiOptions {
	readonly engine: Pick<Engine, 'runWithKey' | 'startRun'>
	/** The current version of a deployed app, which says what webhooks it has. */
	readonly current: (app: string) => AppVersion | undefined
	readonly secrets: WebhookSecrets
	/** Where the details of a refused delivery go; the sender only gets a short answer. */
	readonly log: (message: string) => void
}

/** The largest delivery taken: 25 MB, the most GitHub sends. */
const maxBodyBytes = 25 * 1024 * 1024

/** The longest delivery name taken from a header. */
const maxDeliveryNameLength = 200

/** The route an app's webhook is delivered to. */
export function webhookPath(app: string, webhook: string): string {
	return `/webhooks/${encodeURIComponent(app)}/${encodeURIComponent(webhook)}`
}

/**
 * The webhook ingress: `POST /webhooks/:app/:webhook` starts a run for a delivery to a webhook
 * trigger of a deployed app's current version. Everything is checked on the host before a sandbox
 * is made, in this order:
 *
 * | Check | Answer when it fails |
 * |---|---|
 * | a secret is set for the app's webhook | 404 |
 * | the app is deployed, and its current version has the webhook | 404 |
 * | the delivery is signed with the secret | 401 |
 * | the body is JSON, up to 25 MB | 400, 413 |
 * | the payload fits the input side of the trigger's schema, as JSON Schema | 422 |
 *
 * Nothing before the signature check reads more than the credential store and what the app's build
 * declared, so an unsigned request never costs a sandbox.
 *
 * A delivery that passes gets 202 and a new run, named by its delivery id; a redelivery gets 200
 * and the run it started before. The run then applies the schema's `.refine` and `.transform` in
 * the sandbox, and ends as skipped when they turn the delivery down.
 */
export function webhookApi(options: WebhookApiOptions): Hono {
	const { engine, current, secrets, log } = options
	const api = new Hono()
	const refuse = (c: Context, status: 401 | 404, error: string, detail: string) => {
		log(`Refused a delivery to ${c.req.path}: ${detail}`)
		return c.json({ error }, status)
	}
	const notFound = 'There is no such webhook.'

	api.post(
		'/webhooks/:app/:webhook',
		bodyLimit({ maxSize: maxBodyBytes, onError: (c) => c.json({ error: 'The delivery is too large.' }, 413) }),
		async (c) => {
			const appName = c.req.param('app')
			const id = c.req.param('webhook')
			// Undeployed and unset look the same from outside, so names can't be probed.
			const secret = await secrets.get(appName, id, c.req.raw.signal)
			if (secret === undefined)
				return refuse(c, 404, notFound, `no secret is set; set one with \`mesh-flow webhook secret ${appName} ${id}\`.`)
			const deployed = current(appName)
			if (deployed === undefined) return refuse(c, 404, notFound, `there is no app ${appName}; deploy it with \`mesh-flow deploy\`.`)
			const trigger = deployed.manifest.description.triggers.find((candidate) => candidate.kind === 'webhook' && candidate.id === id)
			if (trigger?.kind !== 'webhook') return refuse(c, 404, notFound, `version ${deployed.version} of ${appName} has no webhook ${id}.`)
			const body = new Uint8Array(await c.req.arrayBuffer())
			if (!signatureFits(trigger.signature, secret, c.req.raw.headers, body)) {
				const { scheme, header } = trigger.signature
				return refuse(c, 401, 'The signature does not fit.', `it isn't signed with the secret (${scheme} in ${header}).`)
			}

			let payload: unknown
			try {
				payload = JSON.parse(Buffer.from(body).toString('utf8'))
			} catch {
				return c.json({ error: 'The delivery is not JSON.' }, 400)
			}
			const problems = payloadProblems(trigger.payload, payload)
			if (problems.length > 0) return c.json({ error: `The delivery is not for webhook ${id}.`, problems }, 422)

			const key = `webhook ${appName}/${id}/${deliveryName(trigger.deliveryHeader, c.req.raw.headers, body)}`
			const known = engine.runWithKey(key)
			if (known !== undefined) return c.json({ run: known.id, status: known.status }, 200)
			// Not the request's signal: a sender that hangs up after this point doesn't undo the delivery.
			const record = await engine.startRun({
				app: appName,
				input: payload,
				trigger: { kind: 'webhook', id },
				key,
				abortSignal: AbortSignal.timeout(startRunTimeoutMs),
			})
			return c.json({ run: record.id, status: record.status }, 202)
		},
	)

	api.onError((error, c) => {
		if (error instanceof EngineError && error.code === 'conflict') return c.json({ error: 'The engine is shutting down.' }, 503)
		if (error instanceof EngineError && error.code === 'unavailable') {
			log(`A delivery to ${c.req.path} wasn't started: ${error.message}`)
			return c.json({ error: "The engine can't run this app's models now." }, 503)
		}
		// Removed, or deployed again without the webhook, since the checks above.
		if (error instanceof EngineError && error.code === 'not-found') return c.json({ error: notFound }, 404)
		log(`A delivery to ${c.req.path} failed: ${messageOf(error)}`)
		return c.json({ error: 'The delivery could not be handled.' }, 500)
	})
	return api
}

/** What names a delivery: the delivery header's value, or a hash of the body when there is none. */
function deliveryName(header: string | undefined, headers: Headers, body: Uint8Array): string {
	const named = header === undefined ? null : headers.get(header)
	if (named !== null && named.length > 0 && named.length <= maxDeliveryNameLength) return named
	return `sha256:${createHash('sha256').update(body).digest('hex')}`
}
