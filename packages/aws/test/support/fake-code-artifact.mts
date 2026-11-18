/** What the fake repository was asked, as `<url> <authorization>`, in order. */
export type FakeRepositoryRequests = string[]

/** A fake CodeArtifact repository as the gateway fetches it, and what it was asked. */
export interface FakeRepository {
	readonly fetch: typeof fetch
	readonly requests: FakeRepositoryRequests
}

/** The CodeArtifact host of domain `example` of account `123456789012` in `eu-west-1`. */
export const repositoryHost = 'example-123456789012.d.codeartifact.eu-west-1.amazonaws.com'

/** Where the fake's npm tarballs redirect to, as CodeArtifact hands out signed downloads. */
export const signedDownload = 'https://downloads.example/left-pad-1.3.0.tgz?signature=abc'

/** A token the fake AWS hands out for domain `example`. */
const exampleToken = /^codeartifact-example-\d+$/

/** How npm's `authorization` starts. */
const bearer = 'Bearer '

/** Whether `authorization` carries a token for domain `example`, the way `format` takes it. */
function authorized(format: 'npm' | 'nuget', authorization: string | null): boolean {
	if (authorization === null) return false
	if (format === 'npm') return authorization.startsWith(bearer) && exampleToken.test(authorization.slice(bearer.length))
	const [scheme, encoded = ''] = authorization.split(' ')
	const [user, token = ''] = Buffer.from(encoded, 'base64').toString('utf8').split(':')
	return scheme === 'Basic' && user === 'aws' && exampleToken.test(token)
}

/**
 * A fake of repository `packages` in domain `example`, in place of the host's `fetch`: npm's
 * package document and a tarball that redirects to a signed download, and NuGet's service index,
 * version list and package, each only with a token for the domain. Anything else is a 404.
 */
export function fakeCodeArtifact(): FakeRepository {
	const requests: FakeRepositoryRequests = []
	const fake: typeof fetch = (input, init) => {
		const url = input instanceof Request ? input.url : input.toString()
		const headers = new Headers(init?.headers)
		const authorization = headers.get('authorization')
		requests.push(`${url} ${authorization ?? ''}`)
		if (url === signedDownload) {
			return Promise.resolve(
				authorization === null
					? new Response('tarball', { headers: { 'content-type': 'application/octet-stream' } })
					: new Response(null, { status: 400 }),
			)
		}
		const { host, pathname } = new URL(url)
		const format = pathname.startsWith('/npm/packages/') ? 'npm' : pathname.startsWith('/nuget/packages/') ? 'nuget' : undefined
		if (host !== repositoryHost || format === undefined) return Promise.resolve(new Response(null, { status: 404 }))
		if (!authorized(format, authorization)) return Promise.resolve(new Response('{"error":"Unauthorized"}', { status: 401 }))
		const answers: Record<string, () => Response> = {
			'/npm/packages/left-pad': () => Response.json({ name: 'left-pad', versions: { '1.3.0': {} } }),
			'/npm/packages/left-pad/-/left-pad-1.3.0.tgz': () => new Response(null, { status: 302, headers: { location: signedDownload } }),
			'/nuget/packages/v3/index.json': () => Response.json({ version: '3.0.0', resources: [] }),
			'/nuget/packages/v3/package/example.only/index.json': () => Response.json({ versions: ['1.0.0'] }),
			'/nuget/packages/v3/package/example.only/1.0.0/example.only.1.0.0.nupkg': () => new Response('nupkg'),
		}
		return Promise.resolve(answers[pathname]?.() ?? new Response(null, { status: 404 }))
	}
	return { fetch: fake, requests }
}
