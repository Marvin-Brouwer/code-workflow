import { describe, expect, test } from 'vitest'
import { atlassianResends } from '../src/host/host-options.mts'

const site = 'https://jira.example.com'

/** Whether a request with `method` to `path` on the site is sent again. */
const resent = (method: string, path: string) => atlassianResends({ method, url: new URL(`${site}${path}`) })

describe('atlassianResends', () => {
	test('sends reads, searches sent as a POST, and updates again', () => {
		// Act
		const sentAgain = [
			resent('GET', '/rest/api/3/issue/PROJ-7'),
			resent('POST', '/rest/api/3/search/jql'),
			resent('POST', '/rest/api/2/search'),
			resent('PUT', '/rest/api/2/issue/PROJ-7/properties/mesh-flow'),
		]

		// Assert
		expect(sentAgain).toEqual([true, true, true, true])
	})

	test('sends what makes something new once, and a look-up of who a mention names', () => {
		// Act
		const sentAgain = [
			resent('POST', '/rest/api/2/issue/PROJ-7/comment'),
			resent('POST', '/rest/api/2/issue/PROJ-7/transitions'),
			resent('GET', '/rest/api/3/user'),
			resent('GET', '/wiki/rest/api/user'),
		]

		// Assert
		expect(sentAgain).toEqual([false, false, false, false])
	})
})
