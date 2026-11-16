import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { createSecureContext, type SecureContext } from 'node:tls'
import forge from 'node-forge'

/** A certificate authority made for one sandbox, and the certificates it signs for the hosts its proxy serves. */
export interface CertificateAuthority {
	/** The authority's own certificate, as PEM, for the sandbox to trust. */
	readonly certificatePem: string
	/** A TLS context with a certificate for `host`, signed by the authority. Made once per host. */
	readonly contextFor: (host: string) => SecureContext
}

/** How long the certificates hold: a paused run can wait for weeks, and the authority goes with the run. */
const validDays = 365

/** Starts a day early, so a sandbox clock that lags a little still accepts them. */
const backdateDays = 1

const msPerDay = 24 * 60 * 60 * 1000

/** Bytes of a serial number: random, and positive in DER, so the first bit is cleared. */
const serialBytes = 16

/** An RSA key pair, made by Node's crypto: forge's own key generation is pure JavaScript and slow. */
function newKeys(): forge.pki.rsa.KeyPair {
	const { privateKey, publicKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
	})
	return { privateKey: forge.pki.privateKeyFromPem(privateKey), publicKey: forge.pki.publicKeyFromPem(publicKey) }
}

function newSerial(): string {
	const bytes = randomBytes(serialBytes)
	bytes[0] = (bytes[0] ?? 0) & 0x7f
	return bytes.toString('hex')
}

function certificate(subject: forge.pki.CertificateField[], publicKey: forge.pki.PublicKey): forge.pki.Certificate {
	const made = forge.pki.createCertificate()
	const now = Date.now()
	made.serialNumber = newSerial()
	made.publicKey = publicKey
	made.validity.notBefore = new Date(now - backdateDays * msPerDay)
	made.validity.notAfter = new Date(now + validDays * msPerDay)
	made.setSubject(subject)
	return made
}

/**
 * Makes a certificate authority whose key never leaves this process. It can only make the sandbox
 * trust the sandbox's own proxy: nothing outside trusts it, and it's made again for every run.
 */
export function newCertificateAuthority(): CertificateAuthority {
	const authorityKeys = newKeys()
	const name = [{ name: 'commonName', value: 'mesh-flow sandbox package proxy' }]
	const authority = certificate(name, authorityKeys.publicKey)
	authority.setIssuer(name)
	authority.setExtensions([
		{ name: 'basicConstraints', cA: true, critical: true },
		{ name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
		{ name: 'subjectKeyIdentifier' },
	])
	authority.sign(authorityKeys.privateKey, forge.md.sha256.create())

	// One key for every host: the certificates only differ in the name.
	const hostKeys = newKeys()
	const hostKeyPem = forge.pki.privateKeyToPem(hostKeys.privateKey)
	const contexts = new Map<string, SecureContext>()

	const contextFor = (host: string): SecureContext => {
		const known = contexts.get(host)
		if (known !== undefined) return known
		const made = certificate([{ name: 'commonName', value: host }], hostKeys.publicKey)
		made.setIssuer(authority.subject.attributes)
		made.setExtensions([
			{ name: 'basicConstraints', cA: false },
			{ name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
			{ name: 'extKeyUsage', serverAuth: true },
			{ name: 'subjectAltName', altNames: [{ type: 2, value: host }] },
			{ name: 'authorityKeyIdentifier', keyIdentifier: authority.generateSubjectKeyIdentifier().getBytes() },
		])
		made.sign(authorityKeys.privateKey, forge.md.sha256.create())
		const context = createSecureContext({ key: hostKeyPem, cert: forge.pki.certificateToPem(made) })
		contexts.set(host, context)
		return context
	}

	return Object.freeze({ certificatePem: forge.pki.certificateToPem(authority), contextFor })
}
