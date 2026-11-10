import { describe, expect, test } from 'vitest'
import { commands, formatCommand } from '../src/commands.mts'

describe('commands', () => {
	test('build the arguments of a command from its options', () => {
		// Act
		const args = [
			commands.init({ bare: true, quiet: true }),
			commands.clone('../app.bundle', 'app', { branch: 'main', quiet: true }),
			commands.fetch('origin', ['+refs/heads/*:refs/heads/*'], { prune: true, quiet: true }),
			commands.checkout('fix/7', { create: true, from: 'origin/main', quiet: true }),
			commands.config('user.name'),
			commands.config('user.name', 'mesh-flow'),
			commands.add(),
			commands.status({ untracked: false, nulTerminated: true, paths: ['src'] }),
			commands.reset({ mode: 'hard', to: 'origin/main', quiet: true }),
			commands.restore(['README.md'], { source: 'HEAD', staged: true, worktree: true }),
		]

		// Assert
		expect(args).toEqual([
			['init', '--quiet', '--bare'],
			['clone', '--quiet', '--branch', 'main', '../app.bundle', 'app'],
			['fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/heads/*'],
			['checkout', '--quiet', '-b', 'fix/7', 'origin/main'],
			['config', '--get', 'user.name'],
			['config', 'user.name', 'mesh-flow'],
			['add', '--all'],
			['status', '--porcelain=v1', '--untracked-files=no', '-z', '--', 'src'],
			['reset', '--quiet', '--hard', 'origin/main'],
			['restore', '--source=HEAD', '--staged', '--worktree', '--', 'README.md'],
		])
	})
})

describe('formatCommand', () => {
	test('renders the arguments as one shell line, quoting what the shell would read into', () => {
		// Act
		const line = formatCommand(commands.commit({ message: "Fix the login's redirect", quiet: true }))

		// Assert
		expect(line).toBe(String.raw`git commit --quiet --message 'Fix the login'\''s redirect'`)
	})
})
