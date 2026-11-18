import {
	AccessDeniedException,
	AuthorizationPendingException,
	CreateTokenCommand,
	ExpiredTokenException,
	SlowDownException,
	StartDeviceAuthorizationCommand,
	type SSOOIDCClient,
} from '@aws-sdk/client-sso-oidc'
import { duration, type Duration } from '@mesh-flow/duration'
import type { AwsSettings } from './aws-settings.mts'
import { deviceCodeGrant, expiresIn, sessionOf, type RegisteredClient } from './oidc.mts'
import type { StoredSession } from './stored-session.mts'

/** A device authorization the user has yet to approve. */
export interface DeviceAuthorization {
	readonly deviceCode: string
	readonly url: string
	readonly code: string
	readonly expiresAt: Date
	/** How long to wait between looks, as Identity Center asks. */
	readonly interval: Duration
}

/** When Identity Center doesn't say how often to look: RFC 8628's default. */
const defaultInterval = duration.of('5s')

/** How much longer to wait between looks after Identity Center says to slow down: RFC 8628's step. */
export const slowDownStep = duration.of('5s')

/** Waits between looks for the approval. */
export type Wait = (time: Duration, abortSignal: AbortSignal) => Promise<void>

/** The interval after Identity Center said to slow down: longer by {@link slowDownStep}. */
function slowedDown(interval: Duration): Duration {
	return duration({ seconds: interval.to('s') + slowDownStep.to('s') })
}

/** Starts a device authorization for the access portal in the settings. */
export async function startDeviceAuthorization(
	client: RegisteredClient,
	settings: AwsSettings,
	oidc: SSOOIDCClient,
	now: () => Date,
	abortSignal: AbortSignal,
): Promise<DeviceAuthorization> {
	const started = await oidc.send(
		new StartDeviceAuthorizationCommand({ clientId: client.clientId, clientSecret: client.clientSecret, startUrl: settings.startUrl }),
		{ abortSignal },
	)
	const url = started.verificationUriComplete ?? started.verificationUri
	if (started.deviceCode === undefined || started.userCode === undefined || url === undefined)
		throw new Error('Identity Center started no device authorization: it sent no device code, user code or URL.')
	return {
		deviceCode: started.deviceCode,
		url,
		code: started.userCode,
		expiresAt: expiresIn(now(), started.expiresIn, 'the device code'),
		interval: started.interval === undefined ? defaultInterval : duration({ seconds: started.interval }),
	}
}

/** The error for a sign-in that ended before the user approved it. */
function endedUnapproved(): Error {
	return new Error('The AWS sign-in ended before it was approved. Sign in again.')
}

/**
 * Waits until the user approved the device authorization, looking as often as Identity Center
 * allows, and returns the session it signed in to.
 *
 * @throws When the authorization ended before it was approved, or the user denied it.
 */
export async function approvedSession(
	client: RegisteredClient,
	settings: AwsSettings,
	authorization: DeviceAuthorization,
	oidc: SSOOIDCClient,
	now: () => Date,
	wait: Wait,
	abortSignal: AbortSignal,
): Promise<StoredSession> {
	let interval = authorization.interval
	for (;;) {
		if (now() >= authorization.expiresAt) throw endedUnapproved()
		try {
			const token = await oidc.send(
				new CreateTokenCommand({
					clientId: client.clientId,
					clientSecret: client.clientSecret,
					grantType: deviceCodeGrant,
					deviceCode: authorization.deviceCode,
				}),
				{ abortSignal },
			)
			return sessionOf(token, settings, client, now())
		} catch (error) {
			abortSignal.throwIfAborted()
			if (error instanceof SlowDownException) interval = slowedDown(interval)
			else if (error instanceof ExpiredTokenException) throw endedUnapproved()
			else if (error instanceof AccessDeniedException) throw new Error('The AWS sign-in was denied.', { cause: error })
			else if (!(error instanceof AuthorizationPendingException)) throw error
		}
		try {
			await wait(interval, abortSignal)
		} catch (error) {
			// A stop says why: the timer's own error doesn't.
			abortSignal.throwIfAborted()
			throw error
		}
	}
}
