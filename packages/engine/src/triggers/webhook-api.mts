import { createHash } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { DeploymentVersion } from '../app/deployment.mts'
import { startRunTimeout, type Engine } from '../engine/engine.mts'
import { EngineError } from '../engine/engine-error.mts'
import { messageOf } from '../errors.mts'
import { payloadProblems } from './payload-problems.mts'
import { signatureFits } from './signature-fits.mts'
import type { WebhookSecrets } from './webhook-secrets.mts'

/** What the webhook ingress needs. */
export interface WebhookApiOptions {
	readonly engine: Pick<Engine, 'runWithKey' | 'startRun'>
	/** The current version of the deployed app, which says what webhooks it has. */
	readonly current: () => DeploymentVersion | undefined
	readonly secrets: WebhookSecrets
	/** Where the details of a refused delivery go; the sender only gets a short answer. */
	readonly log: (message: string) => void
}

/** The largest delivery taken: 25 MB, the most GitHub sends. */
const maxBodyBytes = 25 * 1024 * 1024

/** The longest delivery name taken from a header. */
const maxDeliveryNameLength = 200

/** The route a webhook is delivered to. */
export function webhookPath(webhook: string): string {
	return `/webhooks/${encodeURIComponent(webhook)}`
}

/**
 * The webhook ingress: `POST /webhooks/:webhook` starts a run for a delivery to a webhook trigger
 * of the deployed app's current version. Everything is checked on the host before a sandbox
 * is made, in this order:
 *
 * | Check | Answer when it fails |
 * |---|---|
 * | a secret is set for the webhook | 404 |
 * | an app is deployed, and its current version has the webhook | 404 |
 * | the delivery is signed with the secret | 401 |
 * | the body is JSON, up to 25 MB | 400, 413 |
 *
 * A signed delivery whose payload doesn't fit the input side of the trigger's schema, as JSON
 * Schema, gets 200 with `skipped` and the problems, and starts no run. It is a delivery the sender
 * was right to send, of an event the trigger doesn't take: senders such as GitLab disable a webhook
 * that keeps getting a 4xx, and so would stop the deliveries that do fit. The first skip per
 * webhook and app version is logged, with the problems, so a schema that never fits shows.
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
	const refuse = (context: Context, status: 401 | 404, error: string, detail: string) => {
		log(`Refused a delivery to ${context.req.path}: ${detail}`)
		return context.json({ error }, status)
	}
	const notFound = 'There is no such webhook.'
	// The webhooks, by app version, a delivery was skipped for: a schema that never fits shows in the log once per version.
	const skippedFor = new Set<string>()

	api.post(
		'/webhooks/:webhook',
		bodyLimit({ maxSize: maxBodyBytes, onError: (context) => context.json({ error: 'The delivery is too large.' }, 413) }),
		async (context) => {
			const id = context.req.param('webhook')
			// Undeployed and unset look the same from outside, so names can't be probed.
			const secret = await secrets.get(id, context.req.raw.signal)
			if (secret === undefined) return refuse(context, 404, notFound, `no secret is set; set one with \`mesh-flow webhook secret ${id}\`.`)
			const deployed = current()
			if (deployed === undefined) return refuse(context, 404, notFound, 'there is no app; deploy it with `mesh-flow deploy`.')
			const trigger = deployed.manifest.description.triggers.find((candidate) => candidate.kind === 'webhook' && candidate.id === id)
			if (trigger?.kind !== 'webhook') return refuse(context, 404, notFound, `version ${deployed.version} of the app has no webhook ${id}.`)
			const body = new Uint8Array(await context.req.arrayBuffer())
			if (!signatureFits(trigger.signature, secret, context.req.raw.headers, body)) {
				const { scheme, header } = trigger.signature
				return refuse(context, 401, 'The signature does not fit.', `it isn't signed with the secret (${scheme} in ${header}).`)
			}

			let payload: unknown
			try {
				payload = JSON.parse(Buffer.from(body).toString('utf8'))
			} catch {
				return context.json({ error: 'The delivery is not JSON.' }, 400)
			}
			const problems = payloadProblems(trigger.payload, payload)
			if (problems.length > 0) {
				const skipped = `${context.req.path} ${deployed.version}`
				if (!skippedFor.has(skipped)) {
					skippedFor.add(skipped)
					log(`Skipped a delivery to ${context.req.path}, which doesn't fit its schema: ${problems.join('; ')}. Later skips aren't logged.`)
				}
				return context.json({ skipped: `The delivery is not for webhook ${id}.`, problems }, 200)
			}

			const key = `webhook ${id}/${deliveryName(trigger.deliveryHeader, context.req.raw.headers, body)}`
			const known = engine.runWithKey(key)
			if (known !== undefined) return context.json({ run: known.id, status: known.status }, 200)
			// Not the request's signal: a sender that hangs up after this point doesn't undo the delivery.
			const record = await engine.startRun({
				input: payload,
				trigger: { kind: 'webhook', id },
				key,
				abortSignal: startRunTimeout.toAbortSignal(),
			})
			return context.json({ run: record.id, status: record.status }, 202)
		},
	)

	// Any other path, such as the `/webhooks/<app>/<webhook>` of engines that ran several apps, shows in the log too.
	api.notFound((context) => refuse(context, 404, notFound, 'webhooks are delivered to /webhooks/<webhook>.'))

	api.onError((error, context) => {
		if (error instanceof EngineError && error.code === 'conflict') return context.json({ error: 'The engine is shutting down.' }, 503)
		if (error instanceof EngineError && error.code === 'unavailable') {
			log(`A delivery to ${context.req.path} wasn't started: ${error.message}`)
			return context.json({ error: "The engine can't run this app's models now." }, 503)
		}
		// Deployed again without the webhook since the checks above.
		if (error instanceof EngineError && error.code === 'not-found') return context.json({ error: notFound }, 404)
		log(`A delivery to ${context.req.path} failed: ${messageOf(error)}`)
		return context.json({ error: 'The delivery could not be handled.' }, 500)
	})
	return api
}

/** What names a delivery: the delivery header's value, or a hash of the body when there is none. */
function deliveryName(header: string | undefined, headers: Headers, body: Uint8Array): string {
	const named = header === undefined ? null : headers.get(header)
	if (named !== null && named.length > 0 && named.length <= maxDeliveryNameLength) return named
	return `sha256:${createHash('sha256').update(body).digest('hex')}`
}
