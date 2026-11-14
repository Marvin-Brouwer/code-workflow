import { describe, expect, test } from 'vitest'
import { parseImage } from '../../src/gvisor/docker-hub.mts'

describe('parseImage', () => {
	test.each([
		['node:26-slim', 'library/node', '26-slim'],
		['node', 'library/node', 'latest'],
		['bitnami/node:26', 'bitnami/node', '26'],
		['node@sha256:0123', 'library/node', 'sha256:0123'],
	])('reads %s', (image, name, reference) => {
		// Act
		const parsed = parseImage(image)

		// Assert
		expect(parsed).toEqual({ name, reference })
	})

	test.each(['ghcr.io/owner/image:1', 'localhost/image', 'registry.local:5000/image'])(
		'refuses %s, which is not on Docker Hub',
		(image) => {
			// Act
			const parse = () => parseImage(image)

			// Assert
			expect(parse).toThrow('Only Docker Hub images')
		},
	)
})
