import { describe, expect, test } from 'vitest'
import { siteUrl } from '../src/credentials/site-url.mts'

describe('siteUrl', () => {
	test('takes an http(s) URL without the spaces around it or the slash at its end', () => {
		// Act
		const urls = [
			siteUrl(' https://gitlab.example.com/ \n', 'gitlab/url', 'https://gitlab.example.com'),
			siteUrl('http://jira.local', 'jira/url', 'https://jira.example.com'),
		]

		// Assert
		expect(urls).toEqual(['https://gitlab.example.com', 'http://jira.local'])
	})

	test('refuses what is no http(s) URL, naming the credential', () => {
		// Act
		const read = () => siteUrl('gitlab.example.com', 'gitlab/url', 'https://gitlab.example.com')

		// Assert
		expect(read).toThrow(
			"gitlab/url is gitlab.example.com, which isn't an http(s) URL. Set it to where the site is, such as https://gitlab.example.com.",
		)
	})
})
