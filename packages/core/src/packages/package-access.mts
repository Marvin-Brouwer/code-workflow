import { mkdir, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import path from 'node:path'
import type { PackageRegistry } from '@mesh-flow/protocol'
import type { GatewayFetch } from '../gateway/gateway-packages.mts'
import { newCertificateAuthority } from './certificate-authority.mts'
import { startPackageProxy, type PackageProxy } from './package-proxy.mts'

/** What package managers in the sandbox need to restore through the proxy. */
export interface PackageAccessOptions {
	readonly registries: readonly PackageRegistry[]
	/** Fetches a package, through the gateway. */
	readonly fetchStaged: GatewayFetch
	/** Where the authority's certificate goes. */
	readonly directory: string
	readonly abortSignal: AbortSignal
}

/** The environment that points package managers at the proxy and makes them trust it. */
export type PackageEnvironment = Readonly<ReturnType<typeof packageEnvironment>>

/** The running proxy, and the environment that sends package managers to it. */
export interface PackageAccess {
	readonly proxy: PackageProxy
	readonly environment: PackageEnvironment
}

/** Loopback and the sandbox itself, which never go through the proxy: a dev server a test starts is on one of them. */
const noProxyHosts = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', hostname()].join(',')

/** The certificate's file in {@link PackageAccessOptions.directory}. */
const certificateFile = 'package-proxy-ca.pem'

/**
 * Starts the package proxy and returns it with the environment every process in the sandbox needs:
 * `HTTPS_PROXY` (and `HTTP_PROXY`, so plain HTTP is refused too) pointing at it, and the sandbox's
 * authority trusted by Node (`NODE_EXTRA_CA_CERTS`), by OpenSSL, which .NET, curl and git read
 * (`SSL_CERT_FILE`), and by the variables curl and Python's requests read before that. The sandbox
 * has no network, so only the authority's certificates are needed.
 */
export async function startPackageAccess(options: PackageAccessOptions): Promise<PackageAccess> {
	options.abortSignal.throwIfAborted()
	const authority = newCertificateAuthority()
	await mkdir(options.directory, { recursive: true })
	const certificate = path.join(options.directory, certificateFile)
	await writeFile(certificate, authority.certificatePem, { signal: options.abortSignal })
	const proxy = await startPackageProxy({
		registries: options.registries,
		fetchStaged: options.fetchStaged,
		authority,
		abortSignal: options.abortSignal,
	})
	const environment = packageEnvironment(proxy.url, certificate)
	return { proxy, environment }
}

/** The variables that send every process to the proxy at `proxyUrl` and make it trust `certificate`. */
function packageEnvironment(proxyUrl: string, certificate: string) {
	return {
		HTTPS_PROXY: proxyUrl,
		https_proxy: proxyUrl,
		HTTP_PROXY: proxyUrl,
		http_proxy: proxyUrl,
		NO_PROXY: noProxyHosts,
		no_proxy: noProxyHosts,
		NODE_USE_ENV_PROXY: '1',
		// npm reads its own settings before HTTPS_PROXY, and an image may set them.
		npm_config_https_proxy: proxyUrl,
		npm_config_proxy: proxyUrl,
		npm_config_noproxy: noProxyHosts,
		NODE_EXTRA_CA_CERTS: certificate,
		SSL_CERT_FILE: certificate,
		// These win over SSL_CERT_FILE where they are set, as images and other tools do.
		CURL_CA_BUNDLE: certificate,
		REQUESTS_CA_BUNDLE: certificate,
	}
}
