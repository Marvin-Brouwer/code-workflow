import { describe, expect, test } from 'vitest'
import { parseImage, rootfsDirectory } from '../../src/gvisor/rootfs.mts'

describe('parseImage', () => {
	test.each([
		['node:22-slim', 'library/node', '22-slim'],
		['node', 'library/node', 'latest'],
		['bitnami/node:22', 'bitnami/node', '22'],
		['node@sha256:0123', 'library/node', 'sha256:0123'],
	])('reads %s', (image, repository, reference) => {
		// Act
		const parsed = parseImage(image)

		// Assert
		expect(parsed).toEqual({ repository, reference })
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

describe('rootfsDirectory', () => {
	test('gives images that sanitise to the same name their own directory', () => {
		// Act
		const tagged = rootfsDirectory('/images', 'node:22-slim')
		const underscored = rootfsDirectory('/images', 'node_22-slim')

		// Assert
		expect(tagged).not.toBe(underscored)
	})
})
