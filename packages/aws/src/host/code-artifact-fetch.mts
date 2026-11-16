import type { ResolveRegistryFetch } from '@mesh-flow/gateway'
import { z } from 'zod'
import { codeArtifactFormats, codeArtifactHost, codeArtifactPath, CodeArtifactRepository } from '../registries/code-artifact-repository.mts'
import type { AwsSession } from './aws-session.mts'

/** The user NuGet signs in to CodeArtifact as, with the token as its password, as `aws codeartifact login` sets it. */
const nugetUser = 'aws'

/**
 * How the gateway fetches from CodeArtifact repositories: on the host of the repository's own
 * domain only, below one of the repository's paths, with a CodeArtifact token from `session`.
 * npm takes the token as a bearer token, NuGet as the password of the user `aws`, as
 * `aws codeartifact login` sets them up. Without a session it throws an `AwsSignInNeededError`, so
 * the run waits for a sign-in and fetches again.
 */
export function codeArtifactFetch(session: AwsSession): ResolveRegistryFetch {
	return async ({ registry, path }, abortSignal) => {
		const parsed = CodeArtifactRepository.safeParse(registry.settings)
		if (!parsed.success) throw new Error(`${registry.name} isn't a CodeArtifact repository:\n${z.prettifyError(parsed.error)}`)
		const { domain, owner, region, repository } = parsed.data
		const host = codeArtifactHost({ domain, owner, region })
		// The registry comes from the app: the token only goes to the domain it's for.
		if (registry.host !== host) throw new Error(`${registry.name} is on ${host}, not ${registry.host}.`)
		const format = codeArtifactFormats.find((candidate) => path.startsWith(codeArtifactPath(candidate, repository)))
		if (format === undefined) throw new Error(`${path} isn't a package fetch on ${registry.name}.`)
		const { token } = await session.codeArtifactToken({ domain, owner, region }, abortSignal)
		const authorization = format === 'npm' ? `Bearer ${token}` : `Basic ${Buffer.from(`${nugetUser}:${token}`).toString('base64')}`
		return { url: `https://${host}${path}`, headers: { authorization } }
	}
}
