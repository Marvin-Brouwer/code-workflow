import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { signatureFits } from '../src/triggers/signature-fits.mts'

const secret = 'swordfish'
const body = new TextEncoder().encode('{"ok":true}')
const hmac = createHmac('sha256', secret).update(body).digest('hex')
const github = { scheme: 'hmac-sha256', header: 'x-hub-signature-256', prefix: 'sha256=' } as const

describe('signatureFits', () => {
	test.each([
		['the secret in its header', { scheme: 'secret-header', header: 'x-gitlab-token' } as const, { 'X-Gitlab-Token': secret }, true],
		['another secret in the header', { scheme: 'secret-header', header: 'x-gitlab-token' } as const, { 'x-gitlab-token': 'tuna' }, false],
		['an HMAC of the body after its prefix', github, { 'x-hub-signature-256': `sha256=${hmac}` }, true],
		['an HMAC in uppercase hex', github, { 'x-hub-signature-256': `sha256=${hmac.toUpperCase()}` }, true],
		['an HMAC without its prefix', github, { 'x-hub-signature-256': hmac }, false],
		['no header at all', github, {}, false],
	])('%s fits: %s', (_name, scheme, headers, fits) => {
		// Act
		const result = signatureFits(scheme, secret, new Headers(headers), body)

		// Assert
		expect(result).toBe(fits)
	})
})
