import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { PackageRegistry, PackageRequest, PackageResponse } from '@mesh-flow/protocol'
import { newCertificateAuthority } from './certificate-authority.mts'
import { startPackageProxy, type PackageProxy } from './package-proxy.mts'

/** What package managers in the sandbox need to restore through the proxy. */
export interface PackageAccessOptions {
	readonly registries: readonly PackageRegistry[]
	/** Fetches a package, through the gateway. */
	readonly fetch: (request: PackageRequest, abortSignal: AbortSignal) => Promise<PackageResponse>
	/** Where the authority's certificate goes. */
	readonly directory: string
	readonly abortSignal: AbortSignal
}

/** The environment that points package managers at the proxy and makes them trust it. */
export type PackageEnvironment = Readonly<Record<string, string>>

/** The certificate's file in {@link PackageAccessOptions.directory}. */
const certificateFile = 'package-proxy-ca.pem'

/**
 * Starts the package proxy and returns it with the environment every process in the sandbox needs:
 * `HTTPS_PROXY` (and `HTTP_PROXY`, so plain HTTP is refused too) pointing at it, and the sandbox's
 * authority trusted by Node (`NODE_EXTRA_CA_CERTS`), by OpenSSL, which .NET, curl and git read
 * (`SSL_CERT_FILE`), and by the variables curl and Python's requests read before that. The sandbox
 * has no network, so only the authority's certificates are needed.
 */
export async function startPackageAccess(options: PackageAccessOptions): Promise<{ proxy: PackageProxy; environment: PackageEnvironment }> {
	const authority = newCertificateAuthority()
	await mkdir(options.directory, { recursive: true })
	const certificate = path.join(options.directory, certificateFile)
	await writeFile(certificate, authority.certificatePem, { signal: options.abortSignal })
	const proxy = await startPackageProxy({ ...options, authority })
	const environment = {
		HTTPS_PROXY: proxy.url,
		https_proxy: proxy.url,
		HTTP_PROXY: proxy.url,
		http_proxy: proxy.url,
		NO_PROXY: 'localhost,127.0.0.1',
		no_proxy: 'localhost,127.0.0.1',
		NODE_USE_ENV_PROXY: '1',
		// npm reads its own settings before HTTPS_PROXY, and an image may set them.
		npm_config_https_proxy: proxy.url,
		npm_config_proxy: proxy.url,
		NODE_EXTRA_CA_CERTS: certificate,
		SSL_CERT_FILE: certificate,
		// These win over SSL_CERT_FILE where they are set, as images and other tools do.
		CURL_CA_BUNDLE: certificate,
		REQUESTS_CA_BUNDLE: certificate,
	}
	return { proxy, environment }
}
